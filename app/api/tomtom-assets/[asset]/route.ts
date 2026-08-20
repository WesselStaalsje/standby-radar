import { NextResponse } from "next/server";

export const runtime = "nodejs";

const CACHE = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

function orbisAssetUrl(asset: string) {
  const base = "https://api.tomtom.com/maps/orbis/assets";
  if (asset === "style") return `${base}/styles/0.*/style?apiVersion=1&trafficIncidents=incidents_light`;
  if (asset === "sprite-json") return `${base}/sprites/0.*/sprite.json?apiVersion=1&trafficIncidents=incidents_light`;
  if (asset === "sprite-png") return `${base}/sprites/0.*/sprite.png?apiVersion=1&trafficIncidents=incidents_light`;
  return null;
}

function legacyAssetUrl(asset: string, apiKey: string) {
  const key = encodeURIComponent(apiKey);
  if (asset === "style") return `https://api.tomtom.com/style/1/style/22.*?key=${key}&traffic_incidents=2%2Fincidents_light`;
  if (asset === "sprite-json") return `https://api.tomtom.com/style/1/sprite/22.*/sprite.json?key=${key}&traffic_incidents=2%2Fincidents_light`;
  if (asset === "sprite-png") return `https://api.tomtom.com/style/1/sprite/22.*/sprite.png?key=${key}&traffic_incidents=2%2Fincidents_light`;
  return null;
}

async function fetchOrbis(url: string, apiKey: string) {
  return fetch(url, {
    headers: {
      "TomTom-Api-Key": apiKey,
      "TomTom-Api-Version": "1",
      "user-agent": "StandbyRadar/1.0",
    },
    next: { revalidate: 86_400 },
    signal: AbortSignal.timeout(8_000),
  });
}

async function fetchLegacy(url: string) {
  return fetch(url, {
    headers: { "user-agent": "StandbyRadar/1.0" },
    next: { revalidate: 86_400 },
    signal: AbortSignal.timeout(8_000),
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  const apiKey = process.env.TOMTOM_API_KEY;
  const orbisUrl = orbisAssetUrl(asset);
  if (!apiKey || !orbisUrl) return new NextResponse(null, { status: 204 });

  try {
    let response = await fetchOrbis(orbisUrl, apiKey);
    if (!response.ok) {
      const legacyUrl = legacyAssetUrl(asset, apiKey);
      if (legacyUrl) response = await fetchLegacy(legacyUrl);
    }
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
