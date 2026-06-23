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

export interface VolumesResponse {
  rows: VolumeRow[];
  // diagnostics so the UI can surface partial degradation
  generatedAt: string; // when this snapshot was computed (cache fill time)
  ttlSeconds: number; // server cache TTL; the UI polls at this cadence
  stale: boolean; // true when last refresh failed and we served prior data
  prometheusOk: boolean;
  warnings: string[];
}
