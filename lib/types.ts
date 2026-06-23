// Shape returned by the /api/volumes endpoint and rendered by the table.
// One row per iSCSI/democratic-csi PersistentVolumeClaim.

export type VolumeState =
  | "In use" // bound, attached to a node, and a pod is consuming it
  | "Attached" // attached to a node but no running consumer found
  | "Detached" // bound but not attached anywhere
  | "Pending" // PVC not yet bound
  | "Released" // PV released, claim gone
  | "Lost"
  | "Error"
  | "Unknown";

export interface Consumer {
  pod: string;
  namespace: string;
  node?: string;
}

export interface VolumeRow {
  // identity
  name: string; // PVC name
  pvName?: string; // bound PV name
  namespace: string;
  // sizing
  sizeBytes?: number; // provisioned capacity (PV capacity, fallback PVC request)
  usedBytes?: number; // actual filesystem usage from Prometheus (fs-mode only)
  capacityBytes?: number; // filesystem capacity from Prometheus
  usedPercent?: number; // usedBytes / capacityBytes
  usageAvailable: boolean; // false for block-mode (no kubelet stats) -> phase 2
  usageStale?: boolean; // usage from last_over_time fallback (volume unmounted)
  usageAsOf?: string; // ISO timestamp of last known sample, when stale
  usageSource?: "prometheus" | "truenas"; // which source filled usedBytes/usedPercent
  // TrueNAS zvol detail (phase 2; undefined when TrueNAS off / no match)
  allocatedBytes?: number; // real allocated space (ZFS used, incl. snapshots)
  volsizeBytes?: number; // provisioned thin size
  referencedBytes?: number; // data unique to the live zvol
  logicalusedBytes?: number; // pre-compression logical size
  compressRatio?: number; // e.g. 1.83
  snapshotBytes?: number; // space held by snapshots
  // lifecycle
  createdAt?: string; // ISO timestamp (PVC creationTimestamp)
  state: VolumeState;
  bound: boolean; // PVC phase === Bound
  pvcPhase?: string;
  pvPhase?: string;
  volumeMode?: string; // Filesystem | Block
  // storage backend
  dataEngine: string; // e.g. "iscsi (democratic-csi)"
  csiDriver?: string;
  storageClass?: string;
  volumeHandle?: string; // CSI volume handle (used to map to TrueNAS zvol in phase 2)
  // attachment
  attachedNode?: string; // from VolumeAttachment
  attachmentHealthy?: boolean; // VolumeAttachment.status.attached
  consumers: Consumer[]; // pods mounting this PVC
}

// TrueNAS integration health, surfaced so the UI can show a status indicator and
// tell "off" / "connected" / "connected but unmatched" / "error" apart.
export interface TruenasStatusInfo {
  configured: boolean; // TRUENAS_URL + TRUENAS_API_KEY both set
  ok: boolean; // last fetch connected, authed, and queried successfully
  zvolCount: number; // VOLUME datasets returned by TrueNAS
  matched: number; // zvols that mapped to a volume on this page
  error?: string; // failure reason when !ok
}

export interface VolumesResponse {
  rows: VolumeRow[];
  // diagnostics so the UI can surface partial degradation
  generatedAt: string; // when this snapshot was computed (cache fill time)
  ttlSeconds: number; // server cache TTL; the UI polls at this cadence
  stale: boolean; // true when last refresh failed and we served prior data
  prometheusOk: boolean;
  truenasOk: boolean;
  truenas: TruenasStatusInfo;
  warnings: string[];
}
