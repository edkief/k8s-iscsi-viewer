// Thin client for Prometheus instant queries against PROMETHEUS_URL.
// Used to fetch kubelet volume_stats for actual on-disk usage per PVC.

export interface PvcUsage {
  usedBytes?: number;
  capacityBytes?: number;
  availableBytes?: number;
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

// Returns null (rather than throwing) if Prometheus is unreachable/misconfigured,
// so the volume listing degrades gracefully to k8s-only data.
export async function fetchPvcUsage(signal?: AbortSignal): Promise<UsageMap | null> {
  const base = process.env.PROMETHEUS_URL;
  if (!base) return null;

  try {
    const [used, capacity, available] = await Promise.all([
      instant(base, "kubelet_volume_stats_used_bytes", signal),
      instant(base, "kubelet_volume_stats_capacity_bytes", signal),
      instant(base, "kubelet_volume_stats_available_bytes", signal),
    ]);

    const map: UsageMap = new Map();
    const put = (results: PromResult[], field: keyof PvcUsage) => {
      for (const r of results) {
        const k = key(r.metric);
        if (!k) continue;
        const v = Number(r.value[1]);
        if (!Number.isFinite(v)) continue;
        const entry = map.get(k) ?? {};
        entry[field] = v;
        map.set(k, entry);
      }
    };
    put(used, "usedBytes");
    put(capacity, "capacityBytes");
    put(available, "availableBytes");
    return map;
  } catch {
    return null;
  }
}
