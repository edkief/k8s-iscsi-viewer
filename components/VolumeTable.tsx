"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TruenasStatusInfo, VolumeRow, VolumesResponse } from "@/lib/types";
import { formatAge, formatBytes, formatPercent, formatRatio } from "@/lib/format";
import styles from "./VolumeTable.module.css";

type SortKey =
  | "state"
  | "name"
  | "namespace"
  | "sizeBytes"
  | "usedBytes"
  | "createdAt"
  | "dataEngine"
  | "attachedNode";

const SORT_LABELS: Record<SortKey, string> = {
  state: "State",
  name: "Name",
  namespace: "Namespace",
  sizeBytes: "Size",
  usedBytes: "Usage",
  createdAt: "Created",
  dataEngine: "Data engine",
  attachedNode: "Attached to",
};

const DEFAULT_REFRESH_MS = 60000;

export default function VolumeTable() {
  const [data, setData] = useState<VolumesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);

  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("namespace");
  const [sortAsc, setSortAsc] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/volumes", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch on mount. State updates happen asynchronously after await, not
    // synchronously in the effect body, so this is not a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Poll at the server cache TTL — refreshing faster only returns cached data
  // and wastes round-trips, so we align the client to the same cadence.
  const refreshMs = (data?.ttlSeconds ?? DEFAULT_REFRESH_MS / 1000) * 1000;
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, refreshMs);
    return () => clearInterval(id);
  }, [auto, load, refreshMs]);

  const namespaces = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rows ?? []) set.add(r.namespace);
    return [...set].sort();
  }, [data]);

  const rows = useMemo(() => {
    let out = data?.rows ?? [];
    if (namespace) out = out.filter((r) => r.namespace === namespace);
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.pvName ?? "").toLowerCase().includes(q) ||
          r.namespace.toLowerCase().includes(q) ||
          (r.attachedNode ?? "").toLowerCase().includes(q) ||
          r.consumers.some((c) => c.pod.toLowerCase().includes(q)),
      );
    }
    const dir = sortAsc ? 1 : -1;
    return [...out].sort((a, b) => cmp(a, b, sortKey) * dir);
  }, [data, namespace, query, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const arrow = (key: SortKey) =>
    key === sortKey ? <span className={styles.sortArrow}>{sortAsc ? "▲" : "▼"}</span> : null;

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>iSCSI Volumes</h1>
          <p className={styles.subtitle}>
            TrueNAS / democratic-csi PersistentVolumeClaims
            {data && (
              <>
                {" · "}
                {rows.length} of {data.rows.length} shown · updated{" "}
                {formatAge(data.generatedAt)} ago{data.stale ? " (stale)" : ""}
                {auto ? ` · refresh ${data.ttlSeconds}s` : ""}
                {" · "}
                <TruenasStatus t={data.truenas} />
              </>
            )}
          </p>
        </div>
        <div className={styles.controls}>
          <input
            className={styles.input}
            placeholder="Search name / pod / node…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className={styles.select}
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          >
            <option value="">All namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
          <div className={styles.mobileSortWrap}>
            <span className={styles.muted}>Sort:</span>
            <select
              className={styles.select}
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            Auto
          </label>
          <button className={styles.button} onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className={styles.warn}>Error: {error}</div>}
      {data?.warnings.map((w) => (
        <div key={w} className={styles.warn}>
          {w}
        </div>
      ))}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th onClick={() => toggleSort("state")}>State {arrow("state")}</th>
              <th onClick={() => toggleSort("name")}>Name {arrow("name")}</th>
              <th onClick={() => toggleSort("namespace")}>
                Namespace {arrow("namespace")}
              </th>
              <th className={styles.num} onClick={() => toggleSort("sizeBytes")}>
                Size {arrow("sizeBytes")}
              </th>
              <th onClick={() => toggleSort("usedBytes")}>
                Actual size {arrow("usedBytes")}
              </th>
              <th onClick={() => toggleSort("createdAt")}>
                Created {arrow("createdAt")}
              </th>
              <th onClick={() => toggleSort("dataEngine")}>
                Data engine {arrow("dataEngine")}
              </th>
              <th onClick={() => toggleSort("attachedNode")}>
                Attached to {arrow("attachedNode")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={`${r.namespace}/${r.name}/${r.pvName ?? ""}`} r={r} />
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && (
          <div className={styles.empty}>No iSCSI volumes found.</div>
        )}
        {loading && <div className={styles.empty}>Loading…</div>}
      </div>

      <div className={styles.cardList}>
        {rows.map((r) => (
          <Card key={`${r.namespace}/${r.name}/${r.pvName ?? ""}`} r={r} />
        ))}
        {!loading && rows.length === 0 && (
          <div className={styles.empty}>No iSCSI volumes found.</div>
        )}
        {loading && <div className={styles.empty}>Loading…</div>}
      </div>
    </div>
  );
}

// Compact TrueNAS health pill for the header. Distinguishes the four states a
// blank table could otherwise hide: off, error, connected-but-unmatched, and ok.
function TruenasStatus({ t }: { t: TruenasStatusInfo }) {
  if (!t.configured) {
    return (
      <span className={styles.tnDot} title="TRUENAS_URL / TRUENAS_API_KEY not set">
        <span className={styles.tnOff}>●</span> TrueNAS off
      </span>
    );
  }
  if (!t.ok) {
    return (
      <span className={styles.tnDot} title={t.error ?? "TrueNAS query failed"}>
        <span className={styles.tnBad}>●</span> TrueNAS error
      </span>
    );
  }
  if (t.zvolCount > 0 && t.matched === 0) {
    return (
      <span
        className={styles.tnDot}
        title={`Connected and read ${t.zvolCount} zvol(s), but none mapped to a volume on this page — check the zvol path / volumeHandle mapping.`}
      >
        <span className={styles.tnWarn}>●</span> TrueNAS {t.zvolCount} zvols · 0 matched
      </span>
    );
  }
  return (
    <span
      className={styles.tnDot}
      title={`Connected — ${t.zvolCount} zvol(s) read, ${t.matched} matched to volumes here.`}
    >
      <span className={styles.tnOk}>●</span> TrueNAS {t.matched}/{t.zvolCount} matched
    </span>
  );
}

function Row({ r }: { r: VolumeRow }) {
  const [expanded, setExpanded] = useState(false);
  const extraCount = r.consumers.length - 1;

  return (
    <tr>
      <td>
        <StateBadge state={r.state} />
      </td>
      <td>
        <div>{r.name}</div>
        {r.pvName && <div className={`${styles.sub} mono`}>{r.pvName}</div>}
      </td>
      <td>{r.namespace}</td>
      <td className={styles.num}>{formatBytes(r.sizeBytes)}</td>
      <td>
        <Usage r={r} />
      </td>
      <td title={r.createdAt ?? ""}>{formatAge(r.createdAt)}</td>
      <td>
        <div className={styles.sub}>{r.dataEngine}</div>
        {r.storageClass && (
          <div className={`${styles.sub} mono`}>{r.storageClass}</div>
        )}
      </td>
      <td>
        {r.attachedNode ? (
          <div>
            <span className="mono">{r.attachedNode}</span>
            {r.attachmentHealthy === false && (
              <span className={styles.s_bad}> (unhealthy)</span>
            )}
            {r.consumers.length > 0 && (
              <div className={`${styles.sub} mono`}>
                {r.consumers[0].pod}
                {extraCount > 0 && (
                  <>
                    {" "}
                    <button
                      className={styles.expandBtn}
                      onClick={() => setExpanded((v) => !v)}
                    >
                      {expanded ? "less" : `+${extraCount} more`}
                    </button>
                    {expanded &&
                      r.consumers.slice(1).map((c) => (
                        <div key={c.pod}>{c.pod}</div>
                      ))}
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </td>
    </tr>
  );
}

function Card({ r }: { r: VolumeRow }) {
  const [expanded, setExpanded] = useState(false);
  const extraCount = r.consumers.length - 1;

  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <StateBadge state={r.state} />
        <div className={styles.cardIdentity}>
          <span className={styles.cardName}>{r.name}</span>
          <span className={styles.sub}>{r.namespace}</span>
        </div>
      </div>

      <div className={styles.cardGrid}>
        <div className={styles.cardField}>
          <span className={styles.cardLabel}>Size</span>
          <span>{formatBytes(r.sizeBytes)}</span>
        </div>
        <div className={styles.cardField}>
          <span className={styles.cardLabel}>Usage</span>
          <Usage r={r} />
        </div>
        <div className={styles.cardField}>
          <span className={styles.cardLabel}>Created</span>
          <span title={r.createdAt ?? ""}>{formatAge(r.createdAt)}</span>
        </div>
        <div className={styles.cardField}>
          <span className={styles.cardLabel}>Engine</span>
          <span className={styles.sub}>{r.dataEngine}</span>
          {r.storageClass && (
            <span className={`${styles.sub} mono`}>{r.storageClass}</span>
          )}
        </div>
      </div>

      {r.attachedNode && (
        <div className={styles.cardAttach}>
          <span className={styles.cardLabel}>Attached to</span>
          <span className="mono">{r.attachedNode}</span>
          {r.attachmentHealthy === false && (
            <span className={styles.s_bad}> (unhealthy)</span>
          )}
          {r.consumers.length > 0 && (
            <div className={`${styles.sub} mono`}>
              {r.consumers[0].pod}
              {extraCount > 0 && (
                <>
                  {" "}
                  <button
                    className={styles.expandBtn}
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? "less" : `+${extraCount} more`}
                  </button>
                  {expanded &&
                    r.consumers.slice(1).map((c) => (
                      <div key={c.pod}>{c.pod}</div>
                    ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function hasZvolDetail(r: VolumeRow): boolean {
  return (
    r.allocatedBytes != null ||
    r.volsizeBytes != null ||
    r.compressRatio != null ||
    r.snapshotBytes != null ||
    r.logicalusedBytes != null ||
    r.referencedBytes != null
  );
}

function Usage({ r }: { r: VolumeRow }) {
  const [open, setOpen] = useState(false);
  const detail = hasZvolDetail(r);

  let body: ReactNode;
  if (!r.usageAvailable) {
    body = <span className={styles.muted}>n/a (block)</span>;
  } else if (r.usedBytes == null) {
    body = <span className={styles.muted}>—</span>;
  } else {
    const pct = r.usedPercent ?? 0;
    body = (
      <div className={styles.usage}>
        <div className={styles.bar}>
          <div
            className={`${styles.barFill} ${pct >= 0.85 ? styles.high : ""}`}
            style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }}
          />
        </div>
        <span className={styles.num}>
          {formatBytes(r.usedBytes)}
          {r.usedPercent != null && (
            <span className={styles.sub}> ({formatPercent(r.usedPercent)})</span>
          )}
          {r.usageStale && (
            <span
              className={styles.staleFlag}
              title={`Last known usage${
                r.usageAsOf ? ` from ${formatAge(r.usageAsOf)} ago` : ""
              } — volume not currently mounted`}
            >
              {" "}
              ⚠
            </span>
          )}
          {r.usageSource === "truenas" && (
            <span
              className={styles.srcFlag}
              title="From TrueNAS (live zvol). ZFS used includes snapshots — real allocation, not guest-filesystem fill."
            >
              {" "}
              ⓣ
            </span>
          )}
        </span>
      </div>
    );
  }

  if (!detail) return <>{body}</>;
  return (
    <div>
      {body}
      <button className={styles.expandBtn} onClick={() => setOpen((v) => !v)}>
        {open ? "less" : "details"}
      </button>
      {open && <ZvolDetail r={r} />}
    </div>
  );
}

function ZvolDetail({ r }: { r: VolumeRow }) {
  const items: [string, string][] = [];
  if (r.allocatedBytes != null)
    items.push(["Allocated", formatBytes(r.allocatedBytes)]);
  if (r.volsizeBytes != null)
    items.push(["Provisioned", formatBytes(r.volsizeBytes)]);
  if (r.compressRatio != null)
    items.push(["Compression", formatRatio(r.compressRatio)]);
  if (r.snapshotBytes != null)
    items.push(["Snapshots", formatBytes(r.snapshotBytes)]);
  if (r.logicalusedBytes != null)
    items.push(["Logical", formatBytes(r.logicalusedBytes)]);
  if (r.referencedBytes != null)
    items.push(["Referenced", formatBytes(r.referencedBytes)]);

  return (
    <dl className={styles.zvolDetail}>
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function StateBadge({ state }: { state: VolumeRow["state"] }) {
  const cls =
    state === "In use"
      ? styles.s_inuse
      : state === "Attached"
        ? styles.s_attached
        : state === "Detached"
          ? styles.s_detached
          : state === "Released"
            ? styles.s_released
            : state === "Pending"
              ? styles.s_pending
              : styles.s_bad;
  return <span className={`${styles.badge} ${cls}`}>{state}</span>;
}

function cmp(a: VolumeRow, b: VolumeRow, key: SortKey): number {
  switch (key) {
    case "sizeBytes":
      return (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
    case "usedBytes":
      return (a.usedBytes ?? -1) - (b.usedBytes ?? -1);
    case "createdAt":
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    case "attachedNode":
      return (a.attachedNode ?? "").localeCompare(b.attachedNode ?? "");
    default:
      return String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
  }
}
