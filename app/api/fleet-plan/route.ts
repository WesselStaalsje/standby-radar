import { NextResponse } from "next/server";
import { GET as getOperationalLive } from "../live-operational/route";
import type { LiveRadarData } from "@/lib/types";
import { optimizeFleet } from "@/lib/reliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("units") ?? "4");
  const units = Number.isFinite(requested) ? Math.max(1, Math.min(20, Math.floor(requested))) : 4;
  const response = await getOperationalLive(request);
  if (!response.ok) return response;
  const data = await response.json() as LiveRadarData;
  const plan = optimizeFleet(data.advice, units);
  return NextResponse.json({
    generatedAt: data.generatedAt,
    modelVersion: data.meta.modelVersion,
    units,
    plan,
    note: "Optimaliseert marginale incidentrisicodekking op het operationele live-v7 radarbeeld; dubbele standplaatsen en overlappende dekking worden afgewaardeerd. Route-geverifieerde adviezen krijgen voorrang.",
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
