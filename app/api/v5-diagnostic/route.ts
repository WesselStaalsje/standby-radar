import { NextResponse } from "next/server";
import { loadV5Static } from "@/lib/live-v5-data";
import { normalizeRoadDirection } from "@/lib/engine-v2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const context = await loadV5Static();
  const rayonCounts = Object.fromEntries([...new Set(context.candidates.map(item => item.rayon ?? "?"))].map(rayon => [rayon, context.candidates.filter(item => (item.rayon ?? "?") === rayon).length]));
  const probes = context.candidates.slice(0, 40).map(candidate => {
    const direction = normalizeRoadDirection(candidate.direction);
    const nearby = context.roadPoints.filter(point => point.road === candidate.road && (!direction || !normalizeRoadDirection(point.direction) || normalizeRoadDirection(point.direction) === direction) && point.wvkId && Math.abs(point.km - candidate.accessKm) <= 12)
      .sort((a, b) => Math.abs(a.km - candidate.accessKm) - Math.abs(b.km - candidate.accessKm));
    const distinct = [...new Map(nearby.map(point => [point.wvkId, point])).values()].slice(0, 8);
    const routes = distinct.map(point => ({
      targetWvk: point.wvkId,
      targetKm: point.km,
      result: context.graph && candidate.wvkId && point.wvkId ? context.graph.route(candidate.wvkId, point.wvkId, 40) : null,
    }));
    return { id: candidate.id, name: candidate.name, road: candidate.road, direction, rayon: candidate.rayon, accessKm: candidate.accessKm, wvkId: candidate.wvkId ?? null, routes };
  });
  return NextResponse.json({
    nwbEdgeCount: context.nwbEdgeCount,
    graphSize: context.graph?.size ?? 0,
    roadPointCount: context.roadPoints.length,
    candidateCount: context.candidates.length,
    candidateRayonCount: Object.keys(rayonCounts).length,
    rayonCounts,
    travelSiteCount: context.travelSites.length,
    travelFcdSiteCount: context.travelSites.filter(site => /fcd|floating/i.test(site.equipmentType ?? "")).length,
    travelDirectionKnown: context.travelSites.filter(site => site.direction).length,
    travelMappingQuality: context.travelSites.length ? Math.round(context.travelSites.reduce((sum, site) => sum + site.mappingQuality, 0) / context.travelSites.length) : 0,
    errors: context.errors,
    probes,
  }, { headers: { "Cache-Control": "no-store" } });
}
