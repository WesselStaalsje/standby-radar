import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowed = new Set(["", "aim3.js", "OpenLayers.js"]);

export async function GET(request: NextRequest) {
  const asset = request.nextUrl.searchParams.get("asset") ?? "";
  if (!allowed.has(asset)) return new NextResponse("not allowed", { status: 400 });
  const target = `https://www.stichtingimn.nl/ownkaart/${asset}`;
  const response = await fetch(target, {
    cache: "no-store",
    headers: { "user-agent": "StandbyRadar-rayon-source-inspection/1.0" },
  });
  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
