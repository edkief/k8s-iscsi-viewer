import { NextResponse } from "next/server";
import { DeleteError, deleteVolume, getVolumes } from "@/lib/volumes";

// Always run on the Node runtime (the k8s client needs Node APIs) and never cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getVolumes();
    return NextResponse.json(data, {
      // Allow shared/proxy caches to serve the same snapshot to all viewers for
      // the cache lifetime; the server-side cache is the primary throttle.
      headers: {
        "Cache-Control": `public, max-age=${data.ttlSeconds}, stale-while-revalidate=30`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to query Kubernetes", detail: message },
      { status: 502 },
    );
  }
}

// Delete a volume's zvol (and snapshots) on TrueNAS. Gated server-side by
// ENABLE_DELETE and an eligibility re-check; identified by PV name to avoid any
// ambiguity with namespaced PVC names.
export async function DELETE(request: Request) {
  const pvName = new URL(request.url).searchParams.get("pv");
  if (!pvName) {
    return NextResponse.json({ error: "Missing required 'pv' parameter" }, { status: 400 });
  }
  try {
    const result = await deleteVolume(pvName);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof DeleteError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status });
  }
}
