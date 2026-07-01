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
without TrueNAS their actual size shows `n/a (block)` — filled in by Phase 2 (see
below).

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
- `TRUENAS_URL` + `TRUENAS_API_KEY` — optional; enable Phase 2 TrueNAS zvol
  detail and block-mode usage. `TRUENAS_CACHE_TTL_SECONDS` (default `300`) and
  `TRUENAS_INSECURE_TLS` (self-signed certs) tune it. See Phase 2 below.
- `TRUENAS_UI_URL` — optional browser-facing base URL for the per-volume "open in
  TrueNAS" link (deep-links to `/ui/datasets/<id>`). Set this when `TRUENAS_URL`
  is an in-cluster address the browser can't reach; falls back to `TRUENAS_URL`.
- `ENABLE_DELETE` — optional; exposes a per-volume **Delete** action that destroys
  the zvol and its snapshots on TrueNAS (`recursive`). `released` allows it only
  on orphaned/Released PVs (recommended), `all` on any volume not attached or in
  use; off otherwise. See Deleting volumes below.

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

## Phase 2 — TrueNAS API

The Kubernetes API cannot report some things only TrueNAS knows. `lib/truenas.ts`
maps each PV to its zvol via `spec.csi.volumeHandle` (`zvol/<dataset>/<id>` →
`pool.dataset` id) and adds:

- **block-mode volume usage** — fills the Phase-1 `n/a (block)` gap;
- true allocated space (ZFS `used` / `referenced` / `logicalused`) vs thin
  `volsize`, compression ratio, and snapshot space — shown via a per-row
  **details** toggle (progressive disclosure, no extra columns).

Behavior:

- **Fill-gaps-only.** Prometheus stays the primary source for mounted filesystem
  usage; TrueNAS fills block-mode and unmounted volumes and always supplies the
  extra ZFS detail. A `ⓣ` glyph marks a usage figure sourced from TrueNAS.
- **ZFS `used` includes snapshots** — it's real allocation, not guest-filesystem
  fill. The `ⓣ` tooltip says so.
- **Graceful degrade.** Unset/unreachable TrueNAS → rows render from Kubernetes +
  Prometheus exactly as Phase 1, with a warning banner if `TRUENAS_URL` was set
  but the query failed.

Transport is TrueNAS 25.04+ JSON-RPC 2.0 over WebSocket (`auth.login_with_api_key`
+ `pool.dataset.query`), hand-rolled over the `ws` package. The zvol query is
cached on `TRUENAS_CACHE_TTL_SECONDS` (default 300) with the same single-flight /
stale-on-error guarantees as the rest of the app.

Deploy: create the API key secret from `deploy/secret.example.yaml` and set
`TRUENAS_URL` in `deploy/deployment.yaml`. No RBAC change — TrueNAS is external.

Each matched volume's name also deep-links into the TrueNAS web UI
(`/ui/datasets/<id>`); the `pool.dataset` id is exactly the path the UI expects.
The link uses `TRUENAS_UI_URL` (falling back to `TRUENAS_URL`) so it works even
when the API endpoint is an in-cluster address the browser can't reach.

## Deleting volumes

A PV with `reclaimPolicy: Delete` can get stuck in `Released`: ZFS refuses to
destroy a dataset that still has snapshots, so democratic-csi's `DeleteVolume`
keeps failing and the zvol leaks. With `ENABLE_DELETE` set, each eligible row
gets a **Delete** action that:

1. Destroys the zvol **and its snapshots** on TrueNAS via `pool.dataset.delete`
   with `recursive` + `force` — the snapshots are exactly what blocked the CSI
   delete.
2. Marks the volume **pending deletion** (an in-memory marker, 15-min TTL). It
   does **not** write to Kubernetes: with the snapshots gone, democratic-csi's
   periodic `DeleteVolume` retry (~5 min) now succeeds and reaps the PV itself.
   So the RBAC stays read-only.

Safety: off by default; `released` restricts it to orphaned/Released PVs, `all`
to any volume not attached or in use. A volume that is attached to a node or
consumed by a pod is never deletable. The UI requires typing the volume name to
confirm, and the server re-checks eligibility against fresh cluster state before
acting. The **secondary backup pool is never touched** — delete those manually.
