# iSCSI Volume Viewer

A read-only web UI that reproduces the Longhorn PVC table for **iSCSI volumes
provisioned by [democratic-csi](https://github.com/democratic-csi/democratic-csi)
on TrueNAS**. Longhorn ships its own dashboard; iSCSI volumes have none, so they
were previously invisible. This app lists every iSCSI PVC with state, size, actual
usage, attachment, and more — all from the Kubernetes API plus Prometheus.

## What you get (Phase 1)

| Column | Source |
| --- | --- |
| State | derived from PVC phase + VolumeAttachment + consuming pod |
| Name | PVC name (+ bound PV name) |
| Namespace | PVC namespace |
| Size | PV capacity (fallback PVC request) |
| Actual size | Prometheus `kubelet_volume_stats_used_bytes` (filesystem volumes) |
| Created | PVC `creationTimestamp` |
| Data engine | CSI driver / protocol (`iscsi · democratic-csi`) |
| Status | PVC bound state |
| Attached to | node from VolumeAttachment + consuming pod(s) |

**Block-mode volumes** (`volumeMode: Block`) have no kubelet filesystem stats, so
their actual size shows `n/a (block)` — resolved in Phase 2 (see below).

## Architecture

- **Next.js (App Router) + TypeScript**, single deployable.
- **BFF pattern**: all Kubernetes/Prometheus calls happen server-side in the
  `app/api/volumes` route handler (`lib/k8s.ts`, `lib/prometheus.ts`,
  `lib/volumes.ts`). The browser only ever talks to our own JSON API — cluster
  credentials never reach the client.
- **No app-level auth**: put it behind your existing reverse proxy.
- Auth auto-detects: in-cluster ServiceAccount when `KUBERNETES_SERVICE_HOST` is
  set, otherwise your local `~/.kube/config`.

## Configuration

See `.env.example`. Key vars:

- `PROMETHEUS_URL` — Prometheus that scrapes kubelet volume_stats. Required for the
  Actual size column.
- `CACHE_TTL_SECONDS` — recency / refresh cadence (default `60`). See Throttling.
- `DRIVER_NAMES` — optional comma-separated democratic-csi driver name override.
  Defaults to matching any driver containing `democratic-csi`. Longhorn is always
  excluded.

## Throttling & caching

The cluster is queried at most **once per `CACHE_TTL_SECONDS`** (default 60),
regardless of how many browsers/tabs are open:

- A server-side TTL cache holds the last snapshot; all requests within the window
  are served from memory (no API server / Prometheus calls).
- **Single-flight**: concurrent requests during a cache miss share one refresh, so
  a burst of viewers never stampedes the cluster.
- **Stale-on-error**: if a refresh fails, the last good snapshot is served (flagged
  `stale`) instead of erroring.
- The UI polls at the TTL cadence, and responses carry
  `Cache-Control: max-age=<ttl>` so a fronting proxy can coalesce further.

Lower `CACHE_TTL_SECONDS` for fresher data at higher cluster cost; raise it to
reduce load.

## Local development

```bash
pnpm install
cp .env.example .env        # set PROMETHEUS_URL (port-forward Prometheus if needed)
# kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090
pnpm dev                    # uses your ~/.kube/config
```

Open http://localhost:3000. Sanity-check rows against `kubectl get pvc,pv -A` and
the Longhorn UI (Longhorn PVCs must be excluded).

## Deploy (in-cluster)

```bash
docker build -t ghcr.io/your-org/iscsi-viewer:latest .
docker push ghcr.io/your-org/iscsi-viewer:latest
# edit deploy/deployment.yaml image + PROMETHEUS_URL
kubectl apply -f deploy/namespace.yaml
kubectl apply -f deploy/rbac.yaml
kubectl apply -f deploy/deployment.yaml
```

`deploy/rbac.yaml` grants a read-only ClusterRole (`get/list/watch` on
persistentvolumeclaims, persistentvolumes, pods, volumeattachments,
storageclasses). Expose the `iscsi-viewer` Service through your reverse proxy /
ingress.

## Phase 2 — TrueNAS API (not yet implemented)

The Kubernetes API cannot report some things only TrueNAS knows. A future
`lib/truenas.ts` (TrueNAS API v2.0, auth via `TRUENAS_URL` + `TRUENAS_API_KEY`)
would map each PV to its zvol via `spec.csi.volumeHandle` and add:

- true allocated space (`used` / `referenced` / `logicalused`) vs thin `volsize`;
- compression ratio and snapshot space;
- **block-mode volume usage** (filling the Phase-1 `n/a (block)` gap);
- iSCSI target/extent health.

These would merge into the existing rows as optional fields, degrading gracefully
when TrueNAS is unreachable.
