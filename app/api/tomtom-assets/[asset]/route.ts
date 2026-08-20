import { NextResponse } from "next/server";

export const runtime = "nodejs";

const CACHE = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

function assetUrl(asset: string) {
  const base = "https://api.tomtom.com/maps/orbis/assets";
  if (asset === "style") return `${base}/styles/0.*/style?apiVersion=1&trafficIncidents=incidents_light`;
  if (asset === "sprite-json") return `${base}/sprites/0.*/sprite.json?apiVersion=1&trafficIncidents=incidents_light`;
  if (asset === "sprite-png") return `${base}/sprites/0.*/sprite.png?apiVersion=1&trafficIncidents=incidents_light`;
  return null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  const apiKey = process.env.TOMTOM_API_KEY;
  const url = assetUrl(asset);
  if (!apiKey || !url) return new NextResponse(null, { status: 204 });

  try {
    const response = await fetch(url, {
      headers: {
        "TomTom-Api-Key": apiKey,
        "TomTom-Api-Version": "1",
        "user-agent": "StandbyRadar/1.0",
      },
      next: { revalidate: 86_400 },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return new NextResponse(null, { status: 204 });

    const body = await response.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") ?? (asset === "sprite-png" ? "image/png" : "application/json"),
        "cache-control": CACHE,
      },
    });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
