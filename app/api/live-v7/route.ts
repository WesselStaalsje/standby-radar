import { NextResponse } from "next/server";
import type { ConsensusSummary, LiveRadarData, SourceFamilyEvidence, StandbyAdvice } from "@/lib/types";
import { fetchTomTomRelativeFlow, scoreTomTom, type TomTomFlowSample } from "@/lib/tomtom-flow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL_VERSION = "2.2-resilient-directional-tomtom";
const FRESH_MS = 25_000;
const SELF_FETCH_TIMEOUT = 110_000;
const MAX_ATTEMPTS = 3;

type CachedLive = {
  data: LiveRadarData;
  expiresAt: number;
};

type Point = { id: string; lat: number; lng: number };
type Overlay = LiveRadarData["rayons"]["roadOverlays"][number];

let lastGood: CachedLive | null = null;
let inFlight: Promise<LiveRadarData> | null = null;

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function distanceKm(a: [number, number], b: [number, number]) {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function overlayLengthKm(overlay: Overlay) {
  let total = 0;
  for (let i = 1; i < overlay.coordinates.length; i += 1) total += distanceKm(overlay.coordinates[i - 1], overlay.coordinates[i]);
  return total;
}

function pointAlongOverlay(overlay: Overlay, km: number): { lat: number; lng: number } | null {
  const coordinates = overlay.coordinates;
  if (coordinates.length < 2 || overlay.toKm <= overlay.fromKm) return null;
  const expectedLength = Math.max(.1, overlay.toKm - overlay.fromKm);
  const geometryLength = overlayLengthKm(overlay);
  // Some legacy RWS overlay ranges contain only a tiny geometry fragment. Never
  // extrapolate a TomTom match from those incomplete shapes.
  if (geometryLength < Math.max(.5, expectedLength * .35)) return null;

  const fraction = clamp((km - overlay.fromKm) / (overlay.toKm - overlay.fromKm), 0, 1);
  const distances: number[] = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const leg = distanceKm(coordinates[i - 1], coordinates[i]);
    distances.push(leg);
    total += leg;
  }
  if (!total) return null;

  const target = total * fraction;
  let traversed = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const leg = distances[i - 1];
    if (traversed + leg >= target) {
      const t = leg ? (target - traversed) / leg : 0;
      const a = coordinates[i - 1];
      const b = coordinates[i];
      return { lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t };
    }
    traversed += leg;
  }
  const last = coordinates[coordinates.length - 1];
  return { lat: last[0], lng: last[1] };
}

function pointForAdvice(advice: StandbyAdvice, overlays: Overlay[]): Point | null {
  const centerKm = (advice.kmFrom + advice.kmTo) / 2;
  const accessKm = advice.standby.accessKm;
  const standbyDirection = advice.standby.direction ?? null;
  const localStandby = advice.standby.road === advice.road
    && typeof accessKm === "number"
    && accessKm >= advice.kmFrom - 2
    && accessKm <= advice.kmTo + 2
    && (!advice.direction || !standbyDirection || advice.direction === standbyDirection);

  // A verified service area/parking place on the same carriageway is the most
  // directionally reliable point we have and avoids accidentally sampling the
  // opposite motorway carriageway.
  if (localStandby) return { id: advice.id, lat: advice.standby.lat, lng: advice.standby.lng };

  const matching = overlays
    .filter(overlay => overlay.road === advice.road
      && overlay.rayon === advice.rayon
      && centerKm >= overlay.fromKm - .2
      && centerKm <= overlay.toKm + .2
      && (!advice.direction || !overlay.direction || advice.direction === overlay.direction))
    .map(overlay => ({ overlay, length: overlayLengthKm(overlay) }))
    .filter(item => item.length >= Math.max(.5, (item.overlay.toKm - item.overlay.fromKm) * .35))
    .sort((a, b) => Math.abs(((a.overlay.fromKm + a.overlay.toKm) / 2) - centerKm) - Math.abs(((b.overlay.fromKm + b.overlay.toKm) / 2) - centerKm));

  const point = matching.length ? pointAlongOverlay(matching[0].overlay, centerKm) : null;
  return point ? { id: advice.id, lat: point.lat, lng: point.lng } : null;
}

function tomTomReason(sample: TomTomFlowSample) {
  const percentage = Math.round(sample.relativeSpeed * 100);
  if (sample.roadClosure) return `TomTom directioneel: wegsegment gesloten of nagenoeg stil; matchafstand ${sample.distanceMeters} m.`;
  if (sample.relativeSpeed <= .60) return `TomTom directioneel: verkeer rijdt circa ${percentage}% van normale vrije doorstroming; matchafstand ${sample.distanceMeters} m.`;
  if (sample.relativeSpeed <= .85) return `TomTom directioneel: merkbare vertraging, circa ${percentage}% van free-flow; matchafstand ${sample.distanceMeters} m.`;
  return `TomTom directioneel: circa ${percentage}% van normale vrije doorstroming; matchafstand ${sample.distanceMeters} m.`;
}

function tomTomQuality(sample: TomTomFlowSample) {
  if (sample.distanceMeters <= 75) return 95;
  if (sample.distanceMeters <= 150) return 90;
  if (sample.distanceMeters <= 300) return 82;
  if (sample.distanceMeters <= 500) return 70;
  return 50;
}

function consensusWithTomTom(advice: StandbyAdvice, sample: TomTomFlowSample): ConsensusSummary {
  const external: SourceFamilyEvidence = {
    family: "external",
    available: true,
    pressure: clamp(sample.congestionIndex),
    quality: tomTomQuality(sample),
    weight: .95,
    detail: `TomTom flow ${Math.round(sample.relativeSpeed * 100)}% free-flow · ${sample.distanceMeters} m match`,
  };

  const evidence = [
    ...(advice.consensus?.evidence ?? []).filter(item => item.family !== "external"),
    external,
  ];
  const directTraffic = evidence.filter(item => ["physical", "fcd", "roadside", "external"].includes(item.family)
    && item.available && item.pressure !== null && item.quality >= 35);
  const pressures = directTraffic.map(item => item.pressure as number);
  const spread = pressures.length >= 2 ? Math.max(...pressures) - Math.min(...pressures) : 0;
  const conflict = pressures.length >= 2 && spread >= 42;

  const scored = evidence.filter(item => item.available && item.pressure !== null && item.quality > 0);
  const totalWeight = scored.reduce((sum, item) => sum + item.weight * (item.quality / 100), 0);
  const weighted = totalWeight > 0
    ? scored.reduce((sum, item) => sum + (item.pressure as number) * item.weight * (item.quality / 100), 0) / totalWeight
    : advice.congestionIndex;

  let reliability = scored.length
    ? scored.reduce((sum, item) => sum + item.quality * item.weight, 0) / scored.reduce((sum, item) => sum + item.weight, 0)
    : 20;
  reliability += Math.min(12, Math.max(0, directTraffic.length - 1) * 6);
  if (conflict) reliability -= Math.min(35, 15 + spread * .35);

  const hasFcd = advice.fcdAverageSpeedKph !== null && advice.fcdAverageSpeedKph !== undefined;
  if (advice.sensorCount === 0 && !hasFcd && external.quality < 35) reliability = Math.min(reliability, 38);

  const score = Math.round(clamp(weighted));
  return {
    score,
    reliability: Math.round(clamp(reliability)),
    conflict,
    spread: Math.round(spread),
    agreeingFamilies: directTraffic.filter(item => Math.abs((item.pressure as number) - score) <= 22).length,
    evidence,
  };
}

function enhanceAdvice(advice: StandbyAdvice, sample: TomTomFlowSample | undefined): StandbyAdvice {
  if (!sample) return advice;

  const oldConsensus = advice.consensus;
  const consensus = consensusWithTomTom(advice, sample);
  const oldTraffic = advice.trafficPressureScore ?? oldConsensus?.score ?? advice.congestionIndex;
  const trafficDelta = consensus.score - oldTraffic;
  const tomTomCongested = sample.roadClosure || sample.relativeSpeed <= .85;
  const noPhysical = advice.sensorCount === 0;
  const noFcd = (advice.travelTimeSampleCount ?? 0) === 0;
  const independentCongestion = advice.congestionIndex >= 25
    || (advice.fcdAverageSpeedKph !== null && advice.fcdAverageSpeedKph !== undefined && advice.fcdAverageSpeedKph < 90)
    || advice.matrixClusters > 0;

  let score = advice.score;
  let corroboratingSignals = advice.corroboratingSignals;
  const reasons = advice.reasons.filter(reason => !reason.startsWith("TomTom Traffic:") && !reason.startsWith("TomTom directioneel:"));
  reasons.push(tomTomReason(sample));

  if (tomTomCongested) corroboratingSignals = Math.min(6, corroboratingSignals + 1);

  if (noPhysical && noFcd) {
    score += scoreTomTom(sample.relativeSpeed, sample.roadClosure);
    reasons.push("Geen bruikbare fysieke detector of directionele FCD-match: TomTom vult hier de ontbrekende live verkeersdrukcomponent in.");
  } else if (tomTomCongested && independentCongestion) {
    const bonus = Math.min(5, Math.max(1, Math.round(scoreTomTom(sample.relativeSpeed, sample.roadClosure) / 6)));
    score += bonus;
    reasons.push("TomTom bevestigt een onafhankelijk NDW/RWS-vertragingssignaal; alleen een kleine bevestigingsbonus toegepast om dubbeltelling te voorkomen.");
  } else if (tomTomCongested) {
    reasons.push("TomTom ziet meer vertraging dan de overige actuele bronnen; verwerkt in bronconsensus maar niet volledig dubbel bij de operationele score opgeteld.");
  } else if (independentCongestion) {
    reasons.push("TomTom ziet vrijwel vrije doorstroming terwijl een andere bron vertraging meldt; bronconflict kan de betrouwbaarheid bewust verlagen.");
  }

  if (sample.roadClosure && !(noPhysical && noFcd)) score += 6;
  score = Math.round(clamp(score, 0, 96));

  let risk30 = advice.incidentRisk30 ?? score;
  let risk60 = advice.incidentRisk60 ?? score;
  risk30 = clamp(risk30 + trafficDelta * .26);
  risk60 = clamp(risk60 + trafficDelta * .30);
  if (!oldConsensus?.conflict && consensus.conflict) {
    risk30 *= .9;
    risk60 *= .92;
  }
  risk30 = Math.round(clamp(risk30));
  risk60 = Math.round(clamp(risk60));

  const confidence: StandbyAdvice["confidence"] = consensus.reliability >= 78 && !consensus.conflict
    ? "hoog"
    : consensus.reliability >= 50 ? "middel" : "laag";
  const pressure: StandbyAdvice["pressure"] = score >= 65 ? "hoog" : score >= 38 ? "verhoogd" : "rustig";

  return {
    ...advice,
    score,
    pressure,
    confidence,
    recommendedUnits: risk30 >= 78 && confidence !== "laag" ? 2 : risk30 >= 45 ? 1 : 0,
    congestionIndex: noPhysical ? Math.max(advice.congestionIndex, sample.congestionIndex) : advice.congestionIndex,
    corroboratingSignals,
    corroboratingSignalMax: 6,
    reasons,
    trafficPressureScore: consensus.score,
    incidentRisk30: risk30,
    incidentRisk60: risk60,
    reliabilityScore: consensus.reliability,
    consensus,
  };
}

function operationalSources(data: LiveRadarData, tomtom: Awaited<ReturnType<typeof fetchTomTomRelativeFlow>>, staleError: string | null = null) {
  const osm = data.sources.find(source => source.id === "osm-locations");
  const base = data.sources
    .filter(source => source.id !== "tomtom-flow" && source.id !== "osm-locations" && source.id !== "radar-runtime")
    .map(source => source.id === "rws-locations"
      ? {
          ...source,
          name: "Stand-bylocaties (RWS VILD)",
          lineage: osm?.ok
            ? "Rijkswaterstaat VILD primair · OSM aanvullende locaties beschikbaar"
            : "Rijkswaterstaat VILD primair · OSM is optionele best-effort aanvulling en geen operationele afhankelijkheid",
        }
      : source);

  base.push({
    id: "tomtom-flow",
    name: "TomTom directionele verkeersflow",
    ok: tomtom.configured && tomtom.samples.size > 0,
    updatedAt: tomtom.updatedAt,
    error: tomtom.configured
      ? tomtom.error ?? (tomtom.samples.size ? null : "Geen betrouwbare directionele TomTom-match op de getoonde adviezen")
      : "TOMTOM_API_KEY ontbreekt",
    lineage: "TomTom Traffic vector flow · directionele stand-bysegmentmatch · 5 minuten tile-cache",
  });
  base.push({
    id: "radar-runtime",
    name: "Standby Radar runtime",
    ok: staleError === null,
    updatedAt: new Date().toISOString(),
    error: staleError,
    lineage: "Live-v7 circuit breaker · coalescing · retry · last-known-good fallback",
  });
  return base;
}

async function fetchV6(origin: string): Promise<LiveRadarData> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/live-v6`, {
        cache: "no-store",
        signal: AbortSignal.timeout(SELF_FETCH_TIMEOUT),
        headers: {
          "user-agent": "StandbyRadar/2.2",
          "x-standby-radar-parent": "live-v7",
        },
      });
      if (!response.ok) throw new Error(`live-v6 HTTP ${response.status}`);
      return await response.json() as LiveRadarData;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("live-v6 refresh mislukt");
      if (attempt < MAX_ATTEMPTS) await wait(attempt * 350);
    }
  }
  throw lastError ?? new Error("live-v6 refresh mislukt");
}

async function refresh(origin: string): Promise<LiveRadarData> {
  const data = await fetchV6(origin);
  const points = data.advice.flatMap(advice => {
    const point = pointForAdvice(advice, data.rayons.roadOverlays);
    return point ? [point] : [];
  });

  const tomtom = await fetchTomTomRelativeFlow(points, process.env.TOMTOM_API_KEY);
  const advice = data.advice
    .map(item => enhanceAdvice(item, tomtom.samples.get(item.id)))
    .sort((a, b) => (b.incidentRisk30 ?? b.score) - (a.incidentRisk30 ?? a.score)
      || (b.reliabilityScore ?? 0) - (a.reliabilityScore ?? 0));

  const enriched: LiveRadarData = {
    ...data,
    advice,
    sources: operationalSources(data, tomtom),
    meta: {
      ...data.meta,
      modelVersion: MODEL_VERSION,
      tomtomConfigured: tomtom.configured,
      tomtomCoverageSegments: tomtom.samples.size,
      tomtomTileCount: tomtom.tileCount,
      consensusConflictCount: advice.filter(item => item.consensus?.conflict).length,
      note: `${data.meta.note} Live-v7 beschermt de operationele endpoint tegen incidentele NDW/socket-uitval met request-coalescing, retries en een last-known-good fallback. TomTom wordt opnieuw directioneel gematcht op de daadwerkelijk getoonde stand-bysegmenten en telt als onafhankelijke verkeersbron mee in de consensus. OSM blijft alleen een optionele aanvulling op de officiële RWS VILD-stand-bylocaties.`,
    },
  };

  lastGood = { data: enriched, expiresAt: Date.now() + FRESH_MS };
  return enriched;
}

function staleFallback(error: unknown): LiveRadarData | null {
  if (!lastGood) return null;
  const message = error instanceof Error ? error.message : "Live refresh mislukt";
  const data = lastGood.data;
  const tomtomSource = data.sources.find(source => source.id === "tomtom-flow");
  const syntheticTomTom = {
    configured: data.meta.tomtomConfigured ?? Boolean(tomtomSource?.ok),
    updatedAt: tomtomSource?.updatedAt ?? null,
    tileCount: data.meta.tomtomTileCount ?? 0,
    samples: new Map<string, TomTomFlowSample>(),
    error: tomtomSource?.error ?? null,
  };
  return {
    ...data,
    sources: operationalSources(data, syntheticTomTom, `Verse refresh mislukt (${message}); laatste geldige radarbeeld wordt tijdelijk doorgeleverd.`),
    meta: {
      ...data.meta,
      note: `${data.meta.note} Huidige response gebruikt tijdelijk het laatst geldige radarbeeld omdat de verse refresh faalde.`,
    },
  };
}

export async function GET(request: Request) {
  if (lastGood && lastGood.expiresAt > Date.now()) {
    return NextResponse.json(lastGood.data, { headers: { "Cache-Control": "no-store, max-age=0" } });
  }

  const origin = new URL(request.url).origin;
  if (!inFlight) {
    inFlight = refresh(origin).finally(() => { inFlight = null; });
  }

  try {
    const data = await inFlight;
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    const stale = staleFallback(error);
    if (stale) return NextResponse.json(stale, { headers: { "Cache-Control": "no-store, max-age=0" } });
    return NextResponse.json({
      error: "Standby Radar kon geen betrouwbaar live beeld opbouwen",
      detail: error instanceof Error ? error.message : "onbekende fout",
    }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
