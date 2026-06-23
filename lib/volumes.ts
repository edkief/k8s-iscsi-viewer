import type {
  V1PersistentVolume,
  V1PersistentVolumeClaim,
  V1Pod,
  V1VolumeAttachment,
  V1StorageClass,
} from "@kubernetes/client-node";
import { listAll } from "./k8s";
import { fetchPvcUsage, type PvcUsage, type UsageMap } from "./prometheus";
import {
  fetchZvolUsage,
  getTruenasStatus,
  zvolResolver,
  type ZvolResolver,
  type ZvolUsage,
} from "./truenas";
import { parseQuantityToBytes } from "./format";
import type { Consumer, VolumeRow, VolumesResponse, VolumeState } from "./types";

const LONGHORN_DRIVER = "driver.longhorn.io";

// Which CSI drivers count as iSCSI/TrueNAS. Driver name is set at democratic-csi
// install time, so allow an explicit override via DRIVER_NAMES; otherwise match
// anything mentioning democratic-csi. Longhorn is always excluded.
function driverAllowlist(): string[] | null {
  const raw = process.env.DRIVER_NAMES;
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function driverMatches(driver?: string): boolean {
  if (!driver || driver === LONGHORN_DRIVER) return false;
  const allow = driverAllowlist();
  if (allow) return allow.includes(driver);
  return driver.toLowerCase().includes("democratic-csi");
}

function pvcKey(namespace: string | undefined, name: string | undefined): string {
  return `${namespace ?? ""}/${name ?? ""}`;
}

// Server-side TTL cache shared across all clients and browser tabs. This bounds
// load on the API server / Prometheus to one refresh per TTL regardless of how
// many viewers are connected. Configurable via CACHE_TTL_SECONDS (default 60).
export function cacheTtlSeconds(): number {
  const v = Number(process.env.CACHE_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : 60;
}

let cache: { data: VolumesResponse; at: number } | null = null;
let inflight: Promise<VolumesResponse> | null = null;

export async function getVolumes(): Promise<VolumesResponse> {
  const ttlMs = cacheTtlSeconds() * 1000;
  const now = Date.now();

  // Fresh hit.
  if (cache && now - cache.at < ttlMs) return cache.data;

  // Single-flight: concurrent callers during a miss share one refresh.
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      // Note: deliberately no request AbortSignal here — this fetch is shared,
      // so one client navigating away must not cancel everyone else's refresh.
      const data = await computeVolumes();
      cache = { data, at: Date.now() };
      return data;
    } catch (err) {
      // Stale-on-error: keep serving the last good snapshot if we have one.
      if (cache) {
        return {
          ...cache.data,
          stale: true,
          warnings: [
            ...cache.data.warnings,
            `Refresh failed, showing data from ${cache.data.generatedAt}: ${
              err instanceof Error ? err.message : "unknown error"
            }`,
          ],
        };
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

async function computeVolumes(): Promise<VolumesResponse> {
  const warnings: string[] = [];

  const [snap, usage, zvol] = await Promise.all([
    listAll(),
    fetchPvcUsage(),
    fetchZvolUsage(),
  ]);
  const prometheusOk = usage !== null;
  if (!prometheusOk) {
    warnings.push(
      process.env.PROMETHEUS_URL
        ? "Prometheus query failed — actual usage unavailable."
        : "PROMETHEUS_URL not set — actual usage unavailable.",
    );
  }
  // Resolve a PV's volumeHandle to its TrueNAS zvol once, tolerating both the
  // full-path and bare-name handle formats democratic-csi can emit.
  const resolveZvol: ZvolResolver = zvol ? zvolResolver(zvol) : () => undefined;
  // Lookup maps.
  const pvByName = new Map<string, V1PersistentVolume>();
  for (const pv of snap.pvs) if (pv.metadata?.name) pvByName.set(pv.metadata.name, pv);

  const vaByPv = new Map<string, V1VolumeAttachment>();
  for (const va of snap.volumeAttachments) {
    const pvName = va.spec?.source?.persistentVolumeName;
    if (pvName) vaByPv.set(pvName, va);
  }

  const iscsiScNames = new Set<string>();
  for (const sc of snap.storageClasses as V1StorageClass[]) {
    if (driverMatches(sc.provisioner) && sc.metadata?.name) iscsiScNames.add(sc.metadata.name);
  }

  const consumersByPvc = new Map<string, Consumer[]>();
  for (const pod of snap.pods as V1Pod[]) {
    const ns = pod.metadata?.namespace;
    const node = pod.spec?.nodeName;
    for (const vol of pod.spec?.volumes ?? []) {
      const claim = vol.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      const k = pvcKey(ns, claim);
      const list = consumersByPvc.get(k) ?? [];
      list.push({ pod: pod.metadata?.name ?? "?", namespace: ns ?? "", node });
      consumersByPvc.set(k, list);
    }
  }

  const rows: VolumeRow[] = [];
  const seenPv = new Set<string>();

  // PVC-centric: covers bound and pending claims (matches Longhorn's PVC list).
  for (const pvc of snap.pvcs as V1PersistentVolumeClaim[]) {
    const pvName = pvc.spec?.volumeName;
    const pv = pvName ? pvByName.get(pvName) : undefined;
    const csiDriver = pv?.spec?.csi?.driver;
    const sc = pvc.spec?.storageClassName;

    const isIscsi = driverMatches(csiDriver) || (sc != null && iscsiScNames.has(sc));
    if (!isIscsi) continue;
    if (pvName) seenPv.add(pvName);

    rows.push(buildRow(pvc, pv, vaByPv, consumersByPvc, usage, resolveZvol));
  }

  // Orphan iSCSI PVs with no live claim (Released/Available) — surface leaked volumes.
  for (const pv of snap.pvs) {
    const name = pv.metadata?.name;
    if (!name || seenPv.has(name)) continue;
    if (!driverMatches(pv.spec?.csi?.driver)) continue;
    rows.push(buildOrphanRow(pv, vaByPv, resolveZvol));
  }

  rows.sort(
    (a, b) =>
      a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  );

  // How many zvols actually mapped onto a volume on this page. Zero matches with
  // a healthy query almost always means the volumeHandle → dataset id mapping is
  // off (e.g. a different pool/parent path), which is otherwise invisible.
  let matched = 0;
  if (zvol) {
    for (const r of rows) {
      if (r.volumeHandle && resolveZvol(r.volumeHandle)) matched++;
    }
  }

  const status = getTruenasStatus();
  const truenasOk = !status.configured || status.ok;
  if (status.configured && !status.ok) {
    warnings.push(
      `TrueNAS query failed${
        status.error ? `: ${status.error}` : ""
      } — zvol detail / block usage unavailable.`,
    );
  } else if (
    status.configured &&
    status.ok &&
    status.zvolCount > 0 &&
    matched === 0 &&
    rows.length > 0
  ) {
    warnings.push(
      `TrueNAS connected (${status.zvolCount} zvols) but none matched a volume handle — check the zvol path mapping.`,
    );
    const sampleIds = [...zvol!.keys()].slice(0, 3);
    const sampleHandles = rows
      .map((r) => r.volumeHandle)
      .filter((h): h is string => !!h)
      .slice(0, 3);
    console.warn(
      `[truenas] no zvol matched any volume handle. sample dataset ids=${JSON.stringify(
        sampleIds,
      )} sample volumeHandles=${JSON.stringify(sampleHandles)}`,
    );
  }

  return {
    rows,
    generatedAt: new Date().toISOString(),
    ttlSeconds: cacheTtlSeconds(),
    stale: false,
    prometheusOk,
    truenasOk,
    truenas: {
      configured: status.configured,
      ok: status.ok,
      zvolCount: status.zvolCount,
      matched,
      error: status.error,
    },
    warnings,
  };
}

// Show the full CSI driver name rather than collapsing every democratic-csi
// variant to a single label — distinct driver instances (e.g. one per pool/tier)
// are the whole point of the column, and the storage class is shown alongside it.
function dataEngineLabel(csiDriver?: string): string {
  if (!csiDriver) return "iscsi";
  return `iscsi · ${csiDriver}`;
}

function buildRow(
  pvc: V1PersistentVolumeClaim,
  pv: V1PersistentVolume | undefined,
  vaByPv: Map<string, V1VolumeAttachment>,
  consumersByPvc: Map<string, Consumer[]>,
  usage: UsageMap | null,
  resolveZvol: ZvolResolver,
): VolumeRow {
  const namespace = pvc.metadata?.namespace ?? "";
  const name = pvc.metadata?.name ?? "?";
  const pvName = pv?.metadata?.name;

  const sizeBytes =
    parseQuantityToBytes(pv?.spec?.capacity?.storage) ??
    parseQuantityToBytes(pvc.spec?.resources?.requests?.storage) ??
    parseQuantityToBytes(pvc.status?.capacity?.storage);

  const volumeMode = pvc.spec?.volumeMode ?? pv?.spec?.volumeMode ?? "Filesystem";
  const z = resolveZvol(pv?.spec?.csi?.volumeHandle);

  // Prometheus is primary for mounted filesystem volumes; TrueNAS fills the gaps
  // (block-mode, or unmounted with no Prometheus data) and always supplies the
  // extra ZFS detail below.
  const fsMode = volumeMode !== "Block";
  const prom = fsMode ? usage?.get(pvcKey(namespace, name)) : undefined;
  const fill = computeUsage(prom, z, fsMode);

  const va = pvName ? vaByPv.get(pvName) : undefined;
  const attachedNode = va?.spec?.nodeName;
  const attachmentHealthy = va?.status?.attached;
  const consumers = consumersByPvc.get(pvcKey(namespace, name)) ?? [];

  const pvcPhase = pvc.status?.phase;
  const bound = pvcPhase === "Bound";
  const state = deriveState(pvcPhase, !!attachedNode, consumers.length > 0);

  return {
    name,
    pvName,
    namespace,
    sizeBytes,
    usedBytes: fill.usedBytes,
    capacityBytes: fill.capacityBytes,
    usedPercent: fill.usedPercent,
    usageAvailable: fill.usageAvailable,
    usageStale: fill.usageStale,
    usageAsOf: fill.usageAsOf,
    usageSource: fill.usageSource,
    ...zvolFields(z),
    createdAt: pvc.metadata?.creationTimestamp
      ? new Date(pvc.metadata.creationTimestamp).toISOString()
      : undefined,
    state,
    bound,
    pvcPhase,
    pvPhase: pv?.status?.phase,
    volumeMode,
    dataEngine: dataEngineLabel(pv?.spec?.csi?.driver),
    csiDriver: pv?.spec?.csi?.driver,
    storageClass: pvc.spec?.storageClassName ?? undefined,
    volumeHandle: pv?.spec?.csi?.volumeHandle,
    attachedNode,
    attachmentHealthy,
    consumers,
  };
}

// Pick the primary usage figures: Prometheus wins for mounted filesystems;
// otherwise fall back to TrueNAS zvol (also fills block-mode, where Prometheus
// has nothing). The ZFS `used` includes snapshots — it's real allocation, not
// guest-filesystem fill.
function computeUsage(
  prom: PvcUsage | undefined,
  z: ZvolUsage | undefined,
  fsMode: boolean,
): {
  usedBytes?: number;
  capacityBytes?: number;
  usedPercent?: number;
  usageAvailable: boolean;
  usageStale?: boolean;
  usageAsOf?: string;
  usageSource?: "prometheus" | "truenas";
} {
  if (prom?.usedBytes != null) {
    const usedPercent =
      prom.capacityBytes ? prom.usedBytes / prom.capacityBytes : undefined;
    return {
      usedBytes: prom.usedBytes,
      capacityBytes: prom.capacityBytes,
      usedPercent,
      usageAvailable: true,
      usageStale: prom.stale,
      usageAsOf: prom.asOf,
      usageSource: "prometheus",
    };
  }
  if (z?.usedBytes != null) {
    const usedPercent =
      z.volsizeBytes ? z.usedBytes / z.volsizeBytes : undefined;
    return {
      usedBytes: z.usedBytes,
      capacityBytes: z.volsizeBytes,
      usedPercent,
      usageAvailable: true,
      usageSource: "truenas",
    };
  }
  // No usage from either source. Still "available" for filesystem volumes (just
  // missing data → "—"); block volumes without TrueNAS stay n/a.
  return { usageAvailable: fsMode };
}

// Extra ZFS detail fields, always copied through when TrueNAS matched the zvol.
function zvolFields(z: ZvolUsage | undefined) {
  if (!z) return {};
  return {
    allocatedBytes: z.usedBytes,
    volsizeBytes: z.volsizeBytes,
    referencedBytes: z.referencedBytes,
    logicalusedBytes: z.logicalusedBytes,
    compressRatio: z.compressRatio,
    snapshotBytes: z.snapshotBytes,
  };
}

function buildOrphanRow(
  pv: V1PersistentVolume,
  vaByPv: Map<string, V1VolumeAttachment>,
  resolveZvol: ZvolResolver,
): VolumeRow {
  const pvName = pv.metadata?.name;
  const claimRef = pv.spec?.claimRef;
  const va = pvName ? vaByPv.get(pvName) : undefined;
  const pvPhase = pv.status?.phase;

  // No claim ⇒ no kubelet/Prometheus stats; TrueNAS is the only usage source,
  // and surfacing it on leaked PVs shows how much space the orphan still holds.
  const z = resolveZvol(pv.spec?.csi?.volumeHandle);
  const fill = computeUsage(undefined, z, pv.spec?.volumeMode !== "Block");

  return {
    name: claimRef?.name ?? pvName ?? "?",
    pvName,
    namespace: claimRef?.namespace ?? "—",
    sizeBytes: parseQuantityToBytes(pv.spec?.capacity?.storage),
    usedBytes: fill.usedBytes,
    capacityBytes: fill.capacityBytes,
    usedPercent: fill.usedPercent,
    usageAvailable: fill.usageAvailable,
    usageSource: fill.usageSource,
    ...zvolFields(z),
    createdAt: pv.metadata?.creationTimestamp
      ? new Date(pv.metadata.creationTimestamp).toISOString()
      : undefined,
    state: pvPhase === "Released" ? "Released" : pvPhase === "Available" ? "Detached" : "Unknown",
    bound: false,
    pvPhase,
    volumeMode: pv.spec?.volumeMode ?? "Filesystem",
    dataEngine: dataEngineLabel(pv.spec?.csi?.driver),
    csiDriver: pv.spec?.csi?.driver,
    storageClass: pv.spec?.storageClassName ?? undefined,
    volumeHandle: pv.spec?.csi?.volumeHandle,
    attachedNode: va?.spec?.nodeName,
    attachmentHealthy: va?.status?.attached,
    consumers: [],
  };
}

function deriveState(
  phase: string | undefined,
  attached: boolean,
  hasConsumer: boolean,
): VolumeState {
  switch (phase) {
    case "Pending":
      return "Pending";
    case "Lost":
      return "Lost";
    case "Bound":
      if (attached && hasConsumer) return "In use";
      if (attached) return "Attached";
      return "Detached";
    default:
      return phase ? "Unknown" : "Error";
  }
}
