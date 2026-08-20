import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function inspect(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  let detail: string | null = null;
  if (/json|text/i.test(contentType)) {
    detail = new TextDecoder().decode(bytes).slice(0, 300);
  }
  return { status: response.status, ok: response.ok, contentType, bytes: bytes.length, detail };
}

export async function GET() {
  const key = process.env.TOMTOM_API_KEY;
  if (!key) return NextResponse.json({ configured: false }, { status: 200 });

  const classic = await fetch(
    `https://api.tomtom.com/traffic/map/4/tile/flow/relative/9/263/169.pbf?key=${encodeURIComponent(key)}&roadTypes=%5B0%2C1%2C2%2C4%5D&tags=%5Broad_type%2Ctraffic_level%2Ctraffic_road_coverage%2Croad_closure%5D&trafficLevelStep=0.01&margin=0.1`,
    { cache: "no-store", signal: AbortSignal.timeout(8000), headers: { "user-agent": "StandbyRadar/direct-check" } },
  );

  const orbis = await fetch(
    "https://api.tomtom.com/maps/orbis/traffic/flow/vector/tile/9/263/169?apiVersion=2&attributes=tags(relative_speed,road_category,road_closure),roadCategories(motorway,motorway_link)",
    {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: {
        "TomTom-Api-Key": key,
        "TomTom-Api-Version": "2",
        "Accept": "application/vnd.mapbox-vector-tile",
        "user-agent": "StandbyRadar/direct-check",
      },
    },
  );

  return NextResponse.json({ configured: true, classic: await inspect(classic), orbis: await inspect(orbis) }, { headers: { "Cache-Control": "no-store" } });
}
