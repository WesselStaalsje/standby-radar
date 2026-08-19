import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.TOMTOM_API_KEY?.trim();
  if (!key) return NextResponse.json({ configured: false });

  const url = "https://api.tomtom.com/maps/orbis/traffic/flow/vector/tile/9/263/169?apiVersion=2&attributes=tags(relative_speed,road_category,road_closure),roadCategories(motorway,motorway_link)";
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "TomTom-Api-Key": key,
        "TomTom-Api-Version": "2",
        "Accept": "application/vnd.mapbox-vector-tile",
      },
      signal: AbortSignal.timeout(8000),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return NextResponse.json({
      configured: true,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      bytes: body.byteLength,
      detail: response.ok ? null : new TextDecoder().decode(body).slice(0, 800),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ configured: true, status: 0, ok: false, detail: error instanceof Error ? error.message : "fetch failed" }, { headers: { "cache-control": "no-store" } });
  }
}
