import type { LiveRadarData, RoadDirection, SourceStatus, StandbyAdvice } from "@/lib/types";
import {
  haversineKm,
  normalizeRoadDirection,
  parseRwsVildCandidates,
  type CandidateLocation,
} from "@/lib/engine-v2";
import { loadV5Static, type V5StaticContext } from "@/lib/live-v5-data";
import type { RoadMetringPoint } from "@/lib/ndw";

const CENTER = { lat: 51.9, lng: 5.84 };
const REGION_RADIUS_KM = 45;
const CANDIDATE_RADIUS_KM = 38;
const MAX_STANDBY_ETA_MINUTES = 12;
const VILD_CACHE_MS = 6 * 60 * 60 * 1000;
const VILD_URL = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/vild/FeatureServer";
const REGION_ROADS = new Set(["A12", "A15", "A50", "A73", "A325", "A326", "A348"]);
const BBOX = { minLat: 51.48, minLng: 5.34, maxLat: 52.16, maxLng: 6.35 };

type CandidateCache = {
  expiresAt: number;
  candidates: CandidateLocation[];
  updatedAt: string | null;
};

type CoverageResult = {
  data: LiveRadarData;
  source: SourceStatus;
  adjusted: number;
  regionSegments: number;
  candidateCount: number;
};

let candidateCache: CandidateCache | null = null;

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const sameDirection = (a: RoadDirection | undefined, b: RoadDirection | undefined) => {
  const left = normalizeRoadDirection(a);
  const right = normalizeRoadDirection(b);
  return !left || !right || left === right;
};

function candidateKey(candidate: CandidateLocation) {
  return `${candidate.wvkId ?? "?"}:${candidate.lat.toFixed(5)}:${candidate.lng.toFixed(5)}:${candidate.kind}`;
}

async function fetchVildLayer(
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
    headers: { "user-agent": "StandbyRadar/2.4-coverage" },
  });
  if (!response.ok) throw new Error(`RWS VILD ${layer} HTTP ${response.status}`);
  const payload = await response.json();
  return {
    candidates: parseRwsVildCandidates(payload, context.roadPoints, kind, label),
    updatedAt: response.headers.get("last-modified") ?? response.headers.get("date"),
  };
}

async function loadRegionalCandidates(context: V5StaticContext) {
  if (candidateCache && candidateCache.expiresAt > Date.now()) return candidateCache;

  const results = await Promise.all([
    fetchVildLayer(17, context, "parking", "P+R-terrein"),
    fetchVildLayer(18, context, "parking", "parkeerplaats"),
    fetchVildLayer(19, context, "service_area", "serviceplaats"),
    fetchVildLayer(20, context, "parking", "parkeerterrein"),
    fetchVildLayer(23, context, "fuel", "tankstation"),
  ]);

  const all = results.flatMap(result => result.candidates).filter(candidate =>
    candidate.source === "rws"
    && candidate.verified
    && finite(candidate.wvkId)
    && REGION_ROADS.has(candidate.road)
    && haversineKm(candidate, CENTER) <= REGION_RADIUS_KM + 12,
  );

  const unique = new Map<string, CandidateLocation>();
  for (const candidate of all) unique.set(candidateKey(candidate), candidate);

  candidateCache = {
    expiresAt: Date.now() + VILD_CACHE_MS,
    candidates: [...unique.values()],
    updatedAt: results.map(result => result.updatedAt).find(Boolean) ?? null,
  };
  return candidateCache;
}

function representativePoint(advice: StandbyAdvice, context: V5StaticContext) {
  const centerKm = (advice.kmFrom + advice.kmTo) / 2;
  const ids = new Set(advice.wvkIds ?? []);
  const direction = normalizeRoadDirection(advice.direction);

  const byWvk = ids.size
    ? context.roadPoints.filter(point => ids.has(point.wvkId ?? -1))
    : [];
  const byRoad = context.roadPoints.filter(point => {
    if (point.road !== advice.road) return false;
    const pointDirection = normalizeRoadDirection(point.direction);
    if (direction && pointDirection && direction !== pointDirection) return false;
    return point.km >= advice.kmFrom - 1 && point.km <= advice.kmTo + 1;
  });
  const rows = byWvk.length ? byWvk : byRoad;
  return rows.slice().sort((a, b) => Math.abs(a.km - centerKm) - Math.abs(b.km - centerKm))[0] ?? null;
}

function targetWvkIds(advice: StandbyAdvice, point: RoadMetringPoint | null) {
  const ids = [...new Set((advice.wvkIds ?? []).filter(finite))];
  if (ids.length) return ids;
  return point && finite(point.wvkId) ? [point.wvkId] : [];
}

function inRegion(advice: StandbyAdvice, point: RoadMetringPoint | null) {
  if (!REGION_ROADS.has(advice.road) || !point) return false;
  return haversineKm(point, CENTER) <= REGION_RADIUS_KM;
}

function routeCandidate(
  candidate: CandidateLocation,
  targetWvks: number[],
  context: V5StaticContext,
) {
  if (!context.graph || !finite(candidate.wvkId) || !context.graph.hasWvk(candidate.wvkId)) return null;
  const routes = targetWvks
    .map(wvkId => context.graph!.route(candidate.wvkId!, wvkId, 45))
    .filter(route => route.reachable && finite(route.distanceKm) && finite(route.etaMinutes));
  routes.sort((a, b) => (a.etaMinutes ?? Infinity) - (b.etaMinutes ?? Infinity));
  const route = routes[0];
  if (!route || !finite(route.etaMinutes) || route.etaMinutes > MAX_STANDBY_ETA_MINUTES) return null;
  return route;
}

function chooseCandidate(
  advice: StandbyAdvice,
  point: RoadMetringPoint,
  targetWvks: number[],
  candidates: CandidateLocation[],
  context: V5StaticContext,
  usage: Map<string, number>,
) {
  const currentId = advice.standby.id;
  let best: { candidate: CandidateLocation; distanceKm: number; etaMinutes: number; rank: number } | null = null;

  for (const candidate of candidates) {
    const straightLineKm = haversineKm(point, candidate);
    if (straightLineKm > CANDIDATE_RADIUS_KM) continue;
    const route = routeCandidate(candidate, targetWvks, context);
    if (!route || !finite(route.distanceKm) || !finite(route.etaMinutes)) continue;

    const used = usage.get(candidate.id) ?? 0;
    const sameRoadBonus = candidate.road === advice.road ? 1.6 : 0;
    const directionBonus = sameDirection(candidate.direction, advice.direction) ? .45 : 0;
    const keepCurrentBonus = candidate.id === currentId ? .3 : 0;
    const reusePenalty = used * 2.7;
    const rank = route.etaMinutes + straightLineKm * .035 + reusePenalty - sameRoadBonus - directionBonus - keepCurrentBonus;

    if (!best || rank < best.rank) {
      best = {
        candidate,
        distanceKm: route.distanceKm,
        etaMinutes: route.etaMinutes,
        rank,
      };
    }
  }
  return best;
}

function currentIsSafe(advice: StandbyAdvice) {
  const eta = advice.routeEtaMinutes ?? advice.standby.routeEtaMinutes;
  return advice.routeVerified === true && finite(eta) && eta <= MAX_STANDBY_ETA_MINUTES;
}

export async function tightenArnhemNijmegenCoverage(base: LiveRadarData): Promise<CoverageResult> {
  const context = await loadV5Static();
  if (!context.graph) throw new Error("RWS NWB routering niet beschikbaar");
  const regional = await loadRegionalCandidates(context);
  if (!regional.candidates.length) throw new Error("Geen officiële RWS VILD-kandidaten in Arnhem–Nijmegen gevonden");

  const rows = base.advice.map(advice => ({ advice, point: representativePoint(advice, context) }));
  const regionalRows = rows.filter(row => inRegion(row.advice, row.point));
  const usage = new Map<string, number>();
  const replacements = new Map<string, StandbyAdvice>();

  regionalRows.sort((a, b) =>
    (b.advice.incidentRisk30 ?? b.advice.score) - (a.advice.incidentRisk30 ?? a.advice.score)
    || b.advice.score - a.advice.score,
  );

  let adjusted = 0;
  for (const row of regionalRows) {
    if (!row.point) continue;
    const wvks = targetWvkIds(row.advice, row.point);
    if (!wvks.length) continue;
    const chosen = chooseCandidate(row.advice, row.point, wvks, regional.candidates, context, usage);

    if (!chosen) {
      if (currentIsSafe(row.advice)) usage.set(row.advice.standby.id, (usage.get(row.advice.standby.id) ?? 0) + 1);
      continue;
    }

    usage.set(chosen.candidate.id, (usage.get(chosen.candidate.id) ?? 0) + 1);
    const currentEta = row.advice.routeEtaMinutes ?? row.advice.standby.routeEtaMinutes;
    const changed = chosen.candidate.id !== row.advice.standby.id
      || row.advice.routeVerified !== true
      || !finite(currentEta)
      || Math.abs(currentEta - chosen.etaMinutes) >= .2;

    if (!changed) continue;
    adjusted += 1;
    const reason = `Arnhem–Nijmegen dekking: officiële RWS VILD-standby via NWB geverifieerd op ${chosen.distanceKm.toFixed(1)} km / ${chosen.etaMinutes.toFixed(1)} min; maximale dekkingstijd ${MAX_STANDBY_ETA_MINUTES} min.`;
    replacements.set(row.advice.id, {
      ...row.advice,
      standby: {
        ...chosen.candidate,
        routeDistanceKm: chosen.distanceKm,
        routeEtaMinutes: chosen.etaMinutes,
        routeVerified: true,
      },
      routeDistanceKm: chosen.distanceKm,
      routeEtaMinutes: chosen.etaMinutes,
      routeVerified: true,
      reasons: row.advice.reasons.includes(reason) ? row.advice.reasons : [...row.advice.reasons, reason],
    });
  }

  const advice = base.advice.map(item => replacements.get(item.id) ?? item);
  const source: SourceStatus = {
    id: "arnhem-nijmegen-coverage",
    name: "Arnhem–Nijmegen stand-bydekking",
    ok: true,
    updatedAt: regional.updatedAt ?? new Date().toISOString(),
    error: null,
    lineage: `Per wegdeel · officiële RWS VILD/P+R/parkeerlocaties · directionele NWB-routering · maximaal ${MAX_STANDBY_ETA_MINUTES} min · ${adjusted}/${regionalRows.length} segmenten herplaatst`,
  };

  const note = " Arnhem–Nijmegen gebruikt aanvullend een dekkingsguard: per directioneel wegdeel worden officiële RWS VILD-serviceplaatsen, parkeerplaatsen, parkeerterreinen en P+R-locaties buiten de strikte rayonfilter opnieuw bekeken en alleen via directionele NWB-routering binnen maximaal 12 minuten geaccepteerd. Hergebruik wordt afgewaardeerd zodat de stand-bydekking niet onnodig op enkele verre punten samenklontert.";

  return {
    data: {
      ...base,
      advice,
      sources: [...base.sources.filter(item => item.id !== source.id), source],
      meta: {
        ...base.meta,
        modelVersion: "2.4-arnhem-nijmegen-coverage",
        routeVerifiedCount: advice.filter(item => item.routeVerified === true).length,
        note: base.meta.note.includes("Arnhem–Nijmegen gebruikt aanvullend een dekkingsguard") ? base.meta.note : `${base.meta.note}${note}`,
      },
    },
    source,
    adjusted,
    regionSegments: regionalRows.length,
    candidateCount: regional.candidates.length,
  };
}
