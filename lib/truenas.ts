// Live zvol stats from TrueNAS, used to fill usage that kubelet/Prometheus
// cannot report: block-mode volumes (no filesystem stats) and ZFS-only truth
// (real allocated space vs thin volsize, compression, snapshot space).
//
// Transport is the TrueNAS 25.04+ native JSON-RPC 2.0 over WebSocket: there is
// no official Node client, so we hand-roll the framing over the `ws` package
// (chosen over the built-in WebSocket because it exposes rejectUnauthorized for
// self-signed NAS certs). One short-lived connection per refresh — cheap at the
// 5-minute cache cadence, and avoids persistent-connection reconnection logic.

import WebSocket from "ws";

export interface ZvolUsage {
  usedBytes?: number; // real allocated bytes (includes snapshots)
  volsizeBytes?: number; // provisioned (thin) size
  referencedBytes?: number; // data unique to the live zvol
  logicalusedBytes?: number; // pre-compression logical size
  availableBytes?: number;
  compressRatio?: number; // e.g. 1.83
  snapshotBytes?: number; // space held by snapshots
}

// keyed by zvol path (volumeHandle minus the leading "zvol/")
export type ZvolMap = Map<string, ZvolUsage>;

function cacheTtlSeconds(): number {
  const v = Number(process.env.TRUENAS_CACHE_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : 300; // 5 min
}

// democratic-csi freenas-iscsi sets volumeHandle = "zvol/<datasetParentName>/<id>";
// the TrueNAS pool.dataset id is that path without the "zvol/" prefix.
export function zvolKey(volumeHandle?: string): string | undefined {
  if (!volumeHandle) return undefined;
  return volumeHandle.startsWith("zvol/") ? volumeHandle.slice(5) : volumeHandle;
}

// Derive the JSON-RPC WebSocket URL from the configured base host.
function wsUrl(base: string): string {
  const trimmed = base.replace(/\/$/, "");
  const ws = trimmed.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${ws}/api/current`;
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string } | null;
}

// Numeric ZFS property values arrive as { rawvalue, value, parsed }. We want the
// machine-readable parsed number; guard non-finite.
function parsed(prop: unknown): number | undefined {
  if (prop && typeof prop === "object" && "parsed" in prop) {
    const v = Number((prop as { parsed: unknown }).parsed);
    return Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

const TIMEOUT_MS = 10_000;

// Open one connection, authenticate, query all VOLUME datasets, close. Rejects
// on any transport/auth/protocol failure so the caller can degrade gracefully.
function queryDatasets(base: string, key: string): Promise<ZvolMap> {
  return new Promise<ZvolMap>((resolve, reject) => {
    const opts =
      process.env.TRUENAS_INSECURE_TLS === "true"
        ? { rejectUnauthorized: false }
        : undefined;
    const ws = new WebSocket(wsUrl(base), opts);

    let settled = false;
    const finish = (err: Error | null, map?: ZvolMap) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      if (err) reject(err);
      else resolve(map ?? new Map());
    };

    const timer = setTimeout(
      () => finish(new Error("TrueNAS request timed out")),
      TIMEOUT_MS,
    );

    const send = (id: number, method: string, params: unknown[]) =>
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

    ws.on("open", () => send(1, "auth.login_with_api_key", [key]));

    ws.on("message", (data: WebSocket.RawData) => {
      let msg: RpcResponse;
      try {
        msg = JSON.parse(data.toString()) as RpcResponse;
      } catch {
        return; // ignore non-JSON / notifications
      }
      if (msg.error) {
        finish(new Error(`TrueNAS RPC error: ${msg.error.message ?? "unknown"}`));
        return;
      }
      if (msg.id === 1) {
        if (msg.result !== true) {
          finish(new Error("TrueNAS auth failed"));
          return;
        }
        send(2, "pool.dataset.query", [[["type", "=", "VOLUME"]], {}]);
        return;
      }
      if (msg.id === 2) {
        const map: ZvolMap = new Map();
        for (const item of (msg.result as Record<string, unknown>[]) ?? []) {
          const id = item.id;
          if (typeof id !== "string") continue;
          const compress = item.compressratio;
          map.set(id, {
            usedBytes: parsed(item.used),
            volsizeBytes: parsed(item.volsize),
            referencedBytes: parsed(item.referenced),
            logicalusedBytes: parsed(item.logicalused),
            availableBytes: parsed(item.available),
            snapshotBytes: parsed(item.usedbysnapshots),
            compressRatio: parsed(compress),
          });
        }
        finish(null, map);
      }
    });

    ws.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    ws.on("close", () => finish(new Error("TrueNAS connection closed early")));
  });
}

// The TrueNAS query is comparatively expensive and zvol stats change slowly, so
// cache it on a longer TTL than the live refresh — same shape as getHistoric().
let cache: { map: ZvolMap; at: number } | null = null;
let inflight: Promise<ZvolMap> | null = null;

async function getZvols(base: string, key: string): Promise<ZvolMap> {
  const ttlMs = cacheTtlSeconds() * 1000;
  const now = Date.now();
  if (cache && now - cache.at < ttlMs) return cache.map;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const map = await queryDatasets(base, key);
      cache = { map, at: Date.now() };
      return map;
    } catch {
      // Serve last good snapshot on transient failure; empty otherwise.
      return cache?.map ?? new Map();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Returns null (rather than throwing) when TrueNAS is not configured or the
// fetch fails entirely, so the volume listing degrades to k8s+Prometheus data.
export async function fetchZvolUsage(): Promise<ZvolMap | null> {
  const base = process.env.TRUENAS_URL;
  const key = process.env.TRUENAS_API_KEY;
  if (!base || !key) return null;
  try {
    return await getZvols(base, key);
  } catch {
    return null;
  }
}
