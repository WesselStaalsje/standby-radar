import { NextResponse } from "next/server";
import { loadV5Static } from "@/lib/live-v5-data";
import { primeArnhemNijmegenCandidates } from "@/lib/arnhem-nijmegen-prime";
import { haversineKm, normalizeRoadDirection } from "@/lib/engine-v2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CENTER = { lat: 51.9, lng: 5.84 };
const ROADS = new Set(["A12", "A15", "A50", "A73", "A325", "A326", "A348"]);
const BBOX = { minLat: 51.48, minLng: 5.34, maxLat: 52.16, maxLng: 6.35 };
const VILD = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/vild/FeatureServer";

async function rawLayer(layer: number) {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    geometry: `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outSR: "4326",
    resultRecordCount: "50000",
    f: "geojson",
  });
  const response = await fetch(`${VILD}/${layer}/query?${params}`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!response.ok) return [];
  const json = await response.json() as { features?: Array<{ id?: string | number; geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }> };
  return (json.features ?? []).map(feature => {
    const coordinates = feature.geometry?.coordinates;
    const point = Array.isArray(coordinates) && typeof coordinates[0] === "number" && typeof coordinates[1] === "number" ? coordinates as [number, number] : null;
    const p = feature.properties ?? {};
    return {
      id: feature.id,
      name: [p.first_name, p.secnd_name].map(v => String(v ?? "").trim()).filter(Boolean).join(" "),
      roadnumber: p.roadnumber ?? null,
      roadname: p.roadname ?? null,
      dir: p.dir ?? null,
      loc_des: p.loc_des ?? null,
      lat: point?.[1] ?? null,
      lng: point?.[0] ?? null,
    };
  });
}

export async function GET() {
  const primed = await primeArnhemNijmegenCandidates();
  const context = await loadV5Static();
  const [rawPnr, rawParking] = await Promise.all([rawLayer(17), rawLayer(20)]);
  const rows = context.ranges.flatMap(range => {
    if (!ROADS.has(range.road)) return [];
    const points = context.roadPoints.filter(point => point.road === range.road && point.km >= range.fromKm && point.km <= range.toKm && (!range.direction || !normalizeRoadDirection(point.direction) || normalizeRoadDirection(point.direction) === normalizeRoadDirection(range.direction)));
    const centerKm = (range.fromKm + range.toKm) / 2;
    const point = points.slice().sort((a, b) => Math.abs(a.km - centerKm) - Math.abs(b.km - centerKm))[0];
    if (!point || haversineKm(point, CENTER) > 48) return [];
    const wvks = [...new Set(points.map(item => item.wvkId).filter((value): value is number => typeof value === "number" && Number.isFinite(value)))];
    const candidates = context.candidates.flatMap(candidate => {
      if (!context.graph || !candidate.wvkId) return [];
      const routes = wvks.map(wvk => context.graph!.route(candidate.wvkId!, wvk, 80)).filter(route => route.reachable && route.etaMinutes != null && route.distanceKm != null);
      routes.sort((a, b) => (a.etaMinutes ?? Infinity) - (b.etaMinutes ?? Infinity));
      const route = routes[0];
      if (!route) return [];
      return [{ id: candidate.id, name: candidate.name, road: candidate.road, km: candidate.accessKm, lat: candidate.lat, lng: candidate.lng, eta: route.etaMinutes, distance: route.distanceKm, straight: haversineKm(point, candidate) }];
    }).sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
    return [{ rayon: range.rayon, road: range.road, direction: range.direction, from: range.fromKm, to: range.toKm, point: { lat: point.lat, lng: point.lng, km: point.km, wvks }, best: candidates.slice(0, 8) }];
  });
  return NextResponse.json({
    primed,
    candidateCount: context.candidates.length,
    candidates: context.candidates.filter(candidate => haversineKm(candidate, CENTER) <= 58).map(candidate => ({ id: candidate.id, name: candidate.name, road: candidate.road, km: candidate.accessKm, lat: candidate.lat, lng: candidate.lng, rayon: candidate.rayon, wvkId: candidate.wvkId })),
    rawPnr,
    rawParking,
    ranges: rows,
  });
}
