import { haversineKm, parseRwsVildCandidates, type CandidateLocation } from "@/lib/engine-v2";
import { loadV5Static, type V5StaticContext } from "@/lib/live-v5-data";

const CENTER = { lat: 51.9, lng: 5.84 };
const REGION_RADIUS_KM = 57;
const VILD_URL = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/vild/FeatureServer";
const REGION_ROADS = new Set(["A12", "A15", "A50", "A73", "A325", "A326", "A348"]);
const BBOX = { minLat: 51.48, minLng: 5.34, maxLat: 52.16, maxLng: 6.35 };

let primedUntil = 0;

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

function key(candidate: CandidateLocation) {
  return `${candidate.wvkId ?? "?"}:${candidate.lat.toFixed(5)}:${candidate.lng.toFixed(5)}:${candidate.kind}`;
}

async function fetchLayer(
  layer: number,
  context: V5StaticContext,
  kind: CandidateLocation["kind"],
  label: string,
) {
  const params = new URLSearchParams({
    where: "roadnumber LIKE 'A%'",
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
  const response = await fetch(`${VILD_URL}/${layer}/query?${params}`, {
    next: { revalidate: 21_600 },
    signal: AbortSignal.timeout(12_000),
    headers: { "user-agent": "StandbyRadar/2.4-coverage-prime" },
  });
  if (!response.ok) throw new Error(`RWS VILD ${layer} HTTP ${response.status}`);
  return parseRwsVildCandidates(await response.json(), context.roadPoints, kind, label);
}

export async function primeArnhemNijmegenCandidates() {
  const context = await loadV5Static();
  if (primedUntil > Date.now()) return { added: 0, total: context.candidates.length, cached: true };

  const batches = await Promise.all([
    fetchLayer(18, context, "parking", "parkeerplaats"),
    fetchLayer(19, context, "service_area", "serviceplaats"),
    fetchLayer(23, context, "fuel", "tankstation"),
  ]);

  const existing = new Set(context.candidates.map(key));
  let added = 0;
  for (const candidate of batches.flat()) {
    if (candidate.source !== "rws" || !candidate.verified || !finite(candidate.wvkId)) continue;
    if (!REGION_ROADS.has(candidate.road) || haversineKm(candidate, CENTER) > REGION_RADIUS_KM) continue;
    const candidateKey = key(candidate);
    if (existing.has(candidateKey)) continue;
    // Deliberately keep rayon null here. The Arnhem–Nijmegen route selector is
    // allowed to inspect cross-rayon official RWS places and then proves the
    // actual drive via the direction-aware NWB graph.
    context.candidates.push({ ...candidate, rayon: null });
    existing.add(candidateKey);
    added += 1;
  }

  primedUntil = Date.now() + 6 * 60 * 60 * 1000;
  return { added, total: context.candidates.length, cached: false };
}
