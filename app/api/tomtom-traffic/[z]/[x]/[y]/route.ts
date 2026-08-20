import { NextResponse } from "next/server";

export const runtime = "nodejs";

function validTile(z: number, x: number, y: number) {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < 0 || z > 22) return false;
  const max = 2 ** z;
  return x >= 0 && y >= 0 && x < max && y < max;
}

async function fetchOrbisTraffic(z: number, x: number, y: number, apiKey: string) {
  return fetch(
    `https://api.tomtom.com/maps/orbis/traffic/flow/raster/tile/${z}/${x}/${y}?apiVersion=2&style=light&tileSize=256`,
    {
      headers: {
        "TomTom-Api-Key": apiKey,
        "user-agent": "StandbyRadar/1.0",
      },
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(8_000),
    },
  );
}

async function fetchLegacyTraffic(z: number, x: number, y: number, apiKey: string) {
  const key = encodeURIComponent(apiKey);
  return fetch(
    `https://api.tomtom.com/traffic/map/4/tile/flow/relative-delay/${z}/${x}/${y}.png?key=${key}&thickness=7&tileSize=256`,
    {
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(8_000),
      headers: { "user-agent": "StandbyRadar/1.0" },
    },
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z: rawZ, x: rawX, y: rawY } = await params;
  const z = Number(rawZ);
  const x = Number(rawX);
  const y = Number(rawY);
  const apiKey = process.env.TOMTOM_API_KEY;

  if (!apiKey || !validTile(z, x, y)) return new NextResponse(null, { status: 204 });

  try {
    let response = await fetchOrbisTraffic(z, x, y, apiKey);
    if (!response.ok) response = await fetchLegacyTraffic(z, x, y, apiKey);
    if (!response.ok) return new NextResponse(null, { status: 204 });

    const body = await response.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") ?? "image/png",
        "cache-control": "public, max-age=30, s-maxage=30, stale-while-revalidate=120",
      },
    });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
