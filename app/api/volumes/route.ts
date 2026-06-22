import { NextResponse } from "next/server";
import { getVolumes } from "@/lib/volumes";

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
