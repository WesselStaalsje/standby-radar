import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const target = "https://www.stichtingimn.nl/ownkaart/";
  const response = await fetch(target, {
    cache: "no-store",
    headers: { "user-agent": "StandbyRadar-rayon-source-inspection/1.0" },
  });
  const html = await response.text();
  return new NextResponse(html, {
    status: response.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
