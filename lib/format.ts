// Display helpers for bytes and timestamps. Pure functions, usable client-side.

// Parse a Kubernetes quantity string (e.g. "10Gi", "500Mi", "1T", "1000000000")
// into a number of bytes. Returns undefined if it can't be parsed.
const SUFFIX: Record<string, number> = {
  // binary (Ki = 1024)
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  // decimal (k = 1000)
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
};

export function parseQuantityToBytes(q?: string): number | undefined {
  if (!q) return undefined;
  const m = q.match(/^([0-9.]+)\s*([A-Za-z]+)?$/);
  if (!m) return undefined;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const suffix = m[2];
  if (!suffix) return value;
  const mult = SUFFIX[suffix];
  return mult ? value * mult : undefined;
}

// Format bytes with binary units (matches how storage is provisioned: Gi/Ti).
export function formatBytes(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatPercent(p?: number): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${Math.round(p * 100)}%`;
}

// Compact relative-age string, e.g. "3d", "5h", "12m".
export function formatAge(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const d = Math.floor(secs / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(secs / 3600);
  if (h > 0) return `${h}h`;
  const m = Math.floor(secs / 60);
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}
