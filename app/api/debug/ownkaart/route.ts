import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowed = new Set(["", "aim3.js", "OpenLayers.js"]);

export async function GET(request: NextRequest) {
  const wmsMode = request.nextUrl.searchParams.get("wms");
  const asset = request.nextUrl.searchParams.get("asset") ?? "";
  let target: string;
  if (wmsMode === "http" || wmsMode === "https") {
    target = `${wmsMode}://geoserver.lcm.nl/geoserver/rayons/wms?service=WMS&request=GetCapabilities`;
  } else {
    if (!allowed.has(asset)) return new NextResponse("not allowed", { status: 400 });
    target = `https://www.stichtingimn.nl/ownkaart/${asset}`;
  }
  try {
    const response = await fetch(target, {
      cache: "no-store",
      redirect: "follow",
      headers: { "user-agent": "StandbyRadar-rayon-source-inspection/1.0" },
    });
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-debug-target": target },
    });
  } catch (error) {
    return NextResponse.json({ target, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
