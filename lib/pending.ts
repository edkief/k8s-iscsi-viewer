// Volumes the user has asked to delete. The TrueNAS zvol (and its snapshots) is
// destroyed synchronously, but the Kubernetes PV lingers in Released until
// democratic-csi's external-provisioner retries DeleteVolume (~every 5 min) and,
// now that the blocking snapshots are gone, succeeds and removes the PV. We mark
// the volume "pending deletion" in the meantime so the UI shows the in-flight
// state instead of an unchanged Released row.
//
// Entries expire on a TTL so a volume whose PV never gets reaped (delete didn't
// actually take, replication recreated the dataset, etc.) eventually clears the
// marker and can be retried. Keyed by PV name, which is globally unique.

const TTL_MS = 15 * 60 * 1000; // 15 min — a few CSI retry cycles

const pending = new Map<string, number>(); // pvName -> expiry epoch ms

export function markPendingDeletion(pvName: string): void {
  pending.set(pvName, Date.now() + TTL_MS);
}

export function isPendingDeletion(pvName: string): boolean {
  const exp = pending.get(pvName);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    pending.delete(pvName);
    return false;
  }
  return true;
}
