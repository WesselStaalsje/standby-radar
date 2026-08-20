import { NextResponse } from "next/server";

export const runtime = "nodejs";

function validTile(z: number, x: number, y: number) {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < 0 || z > 22) return false;
  const max = 2 ** z;
  return x >= 0 && y >= 0 && x < max && y < max;
}

export async function GET(_request: Request, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z: rawZ, x: rawX, y: rawY } = await params;
  const z = Number(rawZ);
  const x = Number(rawX);
  const y = Number(rawY);
  const apiKey = process.env.TOMTOM_API_KEY;

  if (!apiKey || !validTile(z, x, y)) return new NextResponse(null, { status: 204 });

  try {
    const response = await fetch(
      `https://api.tomtom.com/maps/orbis/display/raster/tile/${z}/${x}/${y}?apiVersion=2&style=street-light&tileSize=256`,
      {
        headers: {
          "TomTom-Api-Key": apiKey,
          "user-agent": "StandbyRadar/1.0",
        },
        next: { revalidate: 86_400 },
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!response.ok) return new NextResponse(null, { status: 204 });
    const body = await response.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") ?? "image/png",
        "cache-control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
