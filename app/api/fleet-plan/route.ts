import { NextResponse } from "next/server";
import { GET as getOperationalLive } from "../live-operational/route";
import { optimizeOperationalFleet, OPERATIONAL_FLEET_MAX_ETA_MINUTES } from "@/lib/operational-fleet";
import type { LiveRadarData } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("units") ?? "4");
  const units = Number.isFinite(requested) ? Math.max(1, Math.min(20, Math.floor(requested))) : 4;
  const response = await getOperationalLive(request);
  if (!response.ok) return response;
  const data = await response.json() as LiveRadarData;
  const plan = optimizeOperationalFleet(data.advice, units);
  return NextResponse.json({
    generatedAt: data.generatedAt,
    modelVersion: data.meta.modelVersion,
    units,
    plan,
    maxPlacementEtaMinutes: OPERATIONAL_FLEET_MAX_ETA_MINUTES,
    note: `Optimaliseert marginale incidentrisicodekking op het operationele radarbeeld. Alleen route-geverifieerde stand-byposities met maximaal ${OPERATIONAL_FLEET_MAX_ETA_MINUTES} minuten aanrijtijd worden als voertuigpositie gekozen; dubbele standplaatsen en overlappende dekking worden afgewaardeerd.`,
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
