import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.TOMTOM_API_KEY?.trim();
  if (!key) return NextResponse.json({ configured: false }, { status: 200 });

  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=51.4416,5.4697&key=${encodeURIComponent(key)}`;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    return NextResponse.json({
      configured: true,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      detail: text.slice(0, 800),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ configured: true, status: 0, ok: false, detail: error instanceof Error ? error.message : "fetch failed" }, { headers: { "cache-control": "no-store" } });
  }
}
