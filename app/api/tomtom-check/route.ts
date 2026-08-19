import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function probe(name: string, url: string) {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const contentType = response.headers.get("content-type") ?? "";
    let detail = "";
    if (!response.ok || contentType.includes("json") || contentType.includes("text")) {
      detail = (await response.text()).slice(0, 500);
    }
    return { name, status: response.status, ok: response.ok, contentType, detail };
  } catch (error) {
    return { name, status: 0, ok: false, contentType: "", detail: error instanceof Error ? error.message : "fetch failed" };
  }
}

export async function GET() {
  const key = process.env.TOMTOM_API_KEY?.trim();
  if (!key) return NextResponse.json({ configured: false });

  const classic = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/9/263/170.pbf?key=${encodeURIComponent(key)}`;
  const orbis = `https://api.tomtom.com/maps/orbis/traffic/tile/flow/9/263/170.pbf?apiVersion=1&key=${encodeURIComponent(key)}`;

  const [classicResult, orbisResult] = await Promise.all([
    probe("classic-traffic-flow", classic),
    probe("orbis-traffic-flow", orbis),
  ]);

  return NextResponse.json({ configured: true, probes: [classicResult, orbisResult] }, { headers: { "cache-control": "no-store" } });
}
