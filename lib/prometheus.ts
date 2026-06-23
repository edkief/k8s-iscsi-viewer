// Thin client for Prometheus instant queries against PROMETHEUS_URL.
// Used to fetch kubelet volume_stats for actual on-disk usage per PVC.
//
// kubelet_volume_stats_* are only emitted while the PVC is mounted on a node,
// so an instant query shows nothing for unmounted volumes. To still surface a
// last-known figure we fall back to last_over_time(metric[lookback]) for any
// series missing from the live result, and flag those entries as stale.

export interface PvcUsage {
  usedBytes?: number;
  capacityBytes?: number;
  availableBytes?: number;
  // Set only on historic (last_over_time) entries: the volume is not currently
  // mounted, so these numbers are the last values Prometheus saw.
  stale?: boolean;
  asOf?: string; // ISO timestamp of the last sample (best-effort)
}

// keyed by `${namespace}/${pvcName}`
export type UsageMap = Map<string, PvcUsage>;

interface PromResult {
  metric: Record<string, string>;
  value: [number, string]; // [timestamp, sampleValue]
}

interface PromResponse {
  status: string;
  data: { resultType: string; result: PromResult[] };
}

async function instant(base: string, query: string, signal?: AbortSignal): Promise<PromResult[]> {
  const url = `${base.replace(/\/$/, "")}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Prometheus ${res.status} for query: ${query}`);
  }
  const body = (await res.json()) as PromResponse;
  if (body.status !== "success") {
    throw new Error(`Prometheus query not successful: ${query}`);
  }
  return body.data.result;
}

function key(m: Record<string, string>): string | null {
  const ns = m.namespace;
  const pvc = m.persistentvolumeclaim;
  return ns && pvc ? `${ns}/${pvc}` : null;
}

// How far back to look for a last-known figure on unmounted volumes. Anything
// older than this stays blank. Bigger range = heavier historic query.
function lookbackRange(): string {
  return process.env.USAGE_LOOKBACK || "7d";
}

// The historic range query is expensive and its data barely changes (the volume
// is unmounted), so cache it on a longer TTL than the live refresh.
function historicTtlSeconds(): number {
  const v = Number(process.env.HISTORIC_USAGE_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : 600; // 10 min
}

function putValues(map: UsageMap, results: PromResult[], field: keyof PvcUsage) {
  for (const r of results) {
    const k = key(r.metric);
    if (!k) continue;
    const v = Number(r.value[1]);
    if (!Number.isFinite(v)) continue;
    const entry = map.get(k) ?? {};
    (entry[field] as number) = v;
    map.set(k, entry);
  }
}

// Live instant query: only mounted volumes currently being scraped.
async function fetchLive(base: string, signal?: AbortSignal): Promise<UsageMap> {
  const [used, capacity, available] = await Promise.all([
    instant(base, "kubelet_volume_stats_used_bytes", signal),
    instant(base, "kubelet_volume_stats_capacity_bytes", signal),
    instant(base, "kubelet_volume_stats_available_bytes", signal),
  ]);
  const map: UsageMap = new Map();
  putValues(map, used, "usedBytes");
  putValues(map, capacity, "capacityBytes");
  putValues(map, available, "availableBytes");
  return map;
}

// Historic fallback: last value in the lookback window for every series, plus
// the timestamp of that last sample (best-effort, coarse step). Used only for
// volumes absent from the live result (i.e. currently unmounted).
async function fetchHistoric(base: string, signal?: AbortSignal): Promise<UsageMap> {
  const range = lookbackRange();
  const [used, capacity, available, ts] = await Promise.all([
    instant(base, `last_over_time(kubelet_volume_stats_used_bytes[${range}])`, signal),
    instant(base, `last_over_time(kubelet_volume_stats_capacity_bytes[${range}])`, signal),
    instant(base, `last_over_time(kubelet_volume_stats_available_bytes[${range}])`, signal),
    // Last sample's wall-clock time. timestamp() over a subquery yields each
    // step's sample time; last_over_time picks the most recent non-empty one.
    instant(
      base,
      `last_over_time(timestamp(kubelet_volume_stats_used_bytes)[${range}:1h])`,
      signal,
    ),
  ]);
  const map: UsageMap = new Map();
  putValues(map, used, "usedBytes");
  putValues(map, capacity, "capacityBytes");
  putValues(map, available, "availableBytes");
  for (const r of ts) {
    const k = key(r.metric);
    if (!k) continue;
    const secs = Number(r.value[1]);
    if (!Number.isFinite(secs)) continue;
    const entry = map.get(k);
    if (entry) entry.asOf = new Date(secs * 1000).toISOString();
  }
  return map;
}

let historicCache: { map: UsageMap; at: number } | null = null;
let historicInflight: Promise<UsageMap> | null = null;

async function getHistoric(base: string, signal?: AbortSignal): Promise<UsageMap> {
  const ttlMs = historicTtlSeconds() * 1000;
  const now = Date.now();
  if (historicCache && now - historicCache.at < ttlMs) return historicCache.map;
  if (historicInflight) return historicInflight;
  historicInflight = (async () => {
    try {
      const map = await fetchHistoric(base, signal);
      historicCache = { map, at: Date.now() };
      return map;
    } catch {
      // Serve last good historic snapshot on transient failure; empty otherwise.
      return historicCache?.map ?? new Map();
    } finally {
      historicInflight = null;
    }
  })();
  return historicInflight;
}

// Returns null (rather than throwing) if Prometheus is unreachable/misconfigured,
// so the volume listing degrades gracefully to k8s-only data.
export async function fetchPvcUsage(signal?: AbortSignal): Promise<UsageMap | null> {
  const base = process.env.PROMETHEUS_URL;
  if (!base) return null;

  try {
    const live = await fetchLive(base, signal);
    // Fill unmounted volumes from cached historic data, flagged stale.
    const historic = await getHistoric(base, signal);
    for (const [k, h] of historic) {
      if (live.has(k)) continue;
      live.set(k, { ...h, stale: true });
    }
    return live;
  } catch {
    return null;
  }
}
