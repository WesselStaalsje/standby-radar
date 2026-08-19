import { createGunzip, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { GET as getExistingLive } from "../live-v3/route";
import { parseEvents, parseRoadMetringPoints } from "@/lib/ndw";
import type { RoadMetringPoint } from "@/lib/ndw";
import type { LiveRadarData, SourceStatus, StandbyAdvice, TrafficEvent } from "@/lib/types";
import {
  adjustedSensorScoreForTemporaryLimit,
  dripMetrics,
  eventOverlap,
  hasMatchingEvent,
  mapEventToRoad,
  mergeUniqueEvents,
  parseDripSignals,
  parsePlannedSituationRecord,
  parseTemporarySpeedRestrictions,
  parseTravelTimeSample,
  parseTravelTimeSiteRecord,
  plannedMetrics,
  scopeEventToAdvice,
  temporaryLimitForSegment,
  travelTimeMetrics,
  type DripSignal,
  type TemporarySpeedRestriction,
  type TravelTimeSample,
  type TravelTimeSite,
} from "@/lib/ndw-supplemental";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const URLS = {
  measurementConfig: "https://opendata.ndw.nu/measurement_current.xml.gz",
  travelTime: "https://opendata.ndw.nu/traveltime.xml.gz",
  drip: "https://opendata.ndw.nu/dynamische_route_informatie_paneel.xml.gz",
  srti: "https://opendata.ndw.nu/veiligheidsgerelateerde_berichten_srti.xml.gz",
  planning: "https://opendata.ndw.nu/planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz",
  closures: "https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz",
  tempSpeed: "https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_maximum_snelheden.xml.gz",
  bridges: "https://opendata.ndw.nu/planningsfeed_brugopeningen.xml.gz",
  rwsMetering: "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/nwb_metrering/MapServer/2/query",
};

const BBOX = { minLat: 51.15, minLng: 4.20, maxLat: 52.30, maxLng: 6.55 };
const STATIC_TTL = 6 * 60 * 60 * 1000;
const PLANNING_TTL = 5 * 60 * 1000;
const LIVE_TIMEOUT = 12_000;
const PLANNING_TIMEOUT = 18_000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type StaticSupplemental = {
  expires: number;
  roadPoints: RoadMetringPoint[];
  travelSites: TravelTimeSite[];
  meteringUpdatedAt: string | null;
  travelConfigUpdatedAt: string | null;
  travelConfigError: string | null;
};

type PlanningCache = {
  expires: number;
  events: TrafficEvent[];
  updatedAt: string | null;
  error: string | null;
};

type FeedResult<T> = {
  value: T;
  updatedAt: string | null;
  error: string | null;
};

let staticCache: StaticSupplemental | null = null;
let planningCache: PlanningCache | null = null;

async function streamGzipRecords(
  url: string,
  recordName: string,
  onRecord: (record: string) => void,
  timeoutMs: number,
  revalidate = 0,
) {
  const response = await fetch(url, {
    ...(revalidate > 0 ? { next: { revalidate } } : { cache: "no-store" as const }),
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "StandbyRadar/1.0" },
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

  const contentEncoding = response.headers.get("content-encoding") ?? "";
  const stream = Readable.fromWeb(response.body as never);
  const decoded = /gzip/i.test(contentEncoding) ? stream : stream.pipe(createGunzip());
  const decoder = new TextDecoder();
  const startRegex = new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${recordName}\\b`, "i");
  const endRegex = new RegExp(`</(?:(?:[A-Za-z0-9_-]+):)?${recordName}>`, "i");
  let buffer = "";

  for await (const chunk of decoded) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    while (true) {
      const startMatch = startRegex.exec(buffer);
      if (!startMatch) {
        if (buffer.length > 8192) buffer = buffer.slice(-8192);
        break;
      }
      const start = startMatch.index;
      const remainder = buffer.slice(start);
      const endMatch = endRegex.exec(remainder);
      if (!endMatch) {
        buffer = remainder;
        break;
      }
      const end = start + endMatch.index + endMatch[0].length;
      onRecord(buffer.slice(start, end));
      buffer = buffer.slice(end);
    }
  }

  return response.headers.get("last-modified") ?? response.headers.get("date");
}

async function fetchText(url: string, revalidate: number, timeoutMs = LIVE_TIMEOUT) {
  const response = await fetch(url, {
    ...(revalidate > 0 ? { next: { revalidate } } : { cache: "no-store" as const }),
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "StandbyRadar/1.0" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer[0] === 31 && buffer[1] === 139 ? gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
  return {
    text,
    updatedAt: response.headers.get("last-modified") ?? response.headers.get("date"),
  };
}

async function fetchRoadPoints() {
  const all: RoadMetringPoint[] = [];
  let offset = 0;
  let updatedAt: string | null = null;

  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      where: "a_n_nr LIKE 'A%'",
      outFields: "a_n_nr,l_r,hectometer,hectomtrng",
      returnGeometry: "true",
      geometry: `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outSR: "4326",
      resultOffset: String(offset),
      resultRecordCount: "2000",
      f: "geojson",
    });
    const response = await fetch(`${URLS.rwsMetering}?${params}`, {
      next: { revalidate: 21600 },
      signal: AbortSignal.timeout(LIVE_TIMEOUT),
      headers: { "user-agent": "StandbyRadar/1.0" },
    });
    if (!response.ok) throw new Error(`RWS metrering HTTP ${response.status}`);
    updatedAt = response.headers.get("last-modified") ?? response.headers.get("date") ?? updatedAt;
    const json = await response.json() as { features?: unknown[] };
    all.push(...parseRoadMetringPoints(json));
    const count = json.features?.length ?? 0;
    if (count < 2000) break;
    offset += count;
  }

  const unique = new Map(all.map(point => [
    `${point.road}:${point.km}:${point.direction ?? ""}:${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`,
    point,
  ]));
  return { points: [...unique.values()], updatedAt };
}

async function getSupplementalStatic(): Promise<StaticSupplemental> {
  if (staticCache && staticCache.expires > Date.now()) return staticCache;

  const metering = await fetchRoadPoints();
  const travelSites: TravelTimeSite[] = [];
  let travelConfigUpdatedAt: string | null = null;
  let travelConfigError: string | null = null;
  try {
    travelConfigUpdatedAt = await streamGzipRecords(URLS.measurementConfig, "measurementSiteRecord", record => {
      const site = parseTravelTimeSiteRecord(record, metering.points);
      if (site) travelSites.push(site);
    }, PLANNING_TIMEOUT, 21600);
  } catch (error) {
    travelConfigError = error instanceof Error ? error.message : "NDW reistijdconfig niet bereikbaar";
  }

  staticCache = {
    expires: Date.now() + STATIC_TTL,
    roadPoints: metering.points,
    travelSites,
    meteringUpdatedAt: metering.updatedAt,
    travelConfigUpdatedAt,
    travelConfigError,
  };
  return staticCache;
}

async function fetchTravelTimes(sites: TravelTimeSite[]): Promise<FeedResult<Map<string, TravelTimeSample>>> {
  const samples = new Map<string, TravelTimeSample>();
  if (!sites.length) return { value: samples, updatedAt: null, error: "Geen NDW-reistijdtrajecten in configuratie gevonden" };
  const siteMap = new Map(sites.map(site => [site.id, site]));
  try {
    const updatedAt = await streamGzipRecords(URLS.travelTime, "siteMeasurements", record => {
      const sample = parseTravelTimeSample(record, siteMap);
      if (sample) samples.set(sample.siteId, sample);
    }, LIVE_TIMEOUT);
    return { value: samples, updatedAt, error: null };
  } catch (error) {
    return { value: samples, updatedAt: null, error: error instanceof Error ? error.message : "NDW reistijdfeed niet bereikbaar" };
  }
}

async function fetchDrip(): Promise<FeedResult<DripSignal[]>> {
  try {
    const result = await fetchText(URLS.drip, 20);
    return { value: parseDripSignals(result.text), updatedAt: result.updatedAt, error: null };
  } catch (error) {
    return { value: [], updatedAt: null, error: error instanceof Error ? error.message : "NDW DRIP niet bereikbaar" };
  }
}

async function fetchSituationEvents(url: string, points: RoadMetringPoint[], timeout = LIVE_TIMEOUT): Promise<FeedResult<TrafficEvent[]>> {
  const events: TrafficEvent[] = [];
  try {
    const updatedAt = await streamGzipRecords(url, "situationRecord", record => {
      for (const event of parseEvents(record)) {
        const mapped = mapEventToRoad(event, points);
        if (mapped) events.push(mapped);
      }
    }, timeout);
    return { value: events, updatedAt, error: null };
  } catch (error) {
    return { value: events, updatedAt: null, error: error instanceof Error ? error.message : "NDW situatiefeed niet bereikbaar" };
  }
}

async function fetchTemporarySpeeds(points: RoadMetringPoint[]): Promise<FeedResult<TemporarySpeedRestriction[]>> {
  const restrictions: TemporarySpeedRestriction[] = [];
  try {
    const updatedAt = await streamGzipRecords(URLS.tempSpeed, "situationRecord", record => {
      restrictions.push(...parseTemporarySpeedRestrictions(record, points));
    }, LIVE_TIMEOUT);
    return { value: restrictions, updatedAt, error: null };
  } catch (error) {
    return { value: restrictions, updatedAt: null, error: error instanceof Error ? error.message : "NDW tijdelijke snelheden niet bereikbaar" };
  }
}

async function fetchPlannedFeed(url: string, points: RoadMetringPoint[], label: string, horizonHours: number, timeout: number): Promise<FeedResult<TrafficEvent[]>> {
  const events: TrafficEvent[] = [];
  try {
    const updatedAt = await streamGzipRecords(url, "situationRecord", record => {
      const event = parsePlannedSituationRecord(record, points, label, horizonHours);
      if (event) events.push(event);
    }, timeout);
    return { value: events, updatedAt, error: null };
  } catch (error) {
    return { value: events, updatedAt: null, error: error instanceof Error ? error.message : `${label} niet bereikbaar` };
  }
}

async function getPlanning(points: RoadMetringPoint[]): Promise<PlanningCache> {
  if (planningCache && planningCache.expires > Date.now()) return planningCache;
  const result = await fetchPlannedFeed(URLS.planning, points, "NDW planning", 6, PLANNING_TIMEOUT);
  planningCache = {
    expires: Date.now() + PLANNING_TTL,
    events: result.value,
    updatedAt: result.updatedAt,
    error: result.error,
  };
  return planningCache;
}

const makeSource = (id: string, name: string, ok: boolean, updatedAt: string | null, error: string | null, lineage: string): SourceStatus => ({
  id, name, ok, updatedAt, error, lineage,
});

function confidenceRank(confidence: StandbyAdvice["confidence"]) {
  return confidence === "hoog" ? 2 : confidence === "middel" ? 1 : 0;
}

function elevateConfidence(current: StandbyAdvice["confidence"], target: StandbyAdvice["confidence"]) {
  return confidenceRank(target) > confidenceRank(current) ? target : current;
}

function timeLabel(value: string | null | undefined) {
  if (!value) return "onbekend tijdstip";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }).format(date);
}

function newDedicatedEventsForSegment(segment: StandbyAdvice, baseEvents: TrafficEvent[], dedicated: TrafficEvent[]) {
  const baseLocal = eventOverlap(segment, baseEvents);
  return eventOverlap(segment, dedicated).filter(event => !baseLocal.some(existing => {
    if (existing.id === event.id) return true;
    if (existing.roadRef && event.roadRef && existing.roadRef !== event.roadRef) return false;
    const sameFamily = existing.kind === event.kind || ([existing.kind, event.kind].every(kind => kind === "closure" || kind === "obstruction"));
    if (!sameFamily) return false;
    if (existing.roadKm !== null && existing.roadKm !== undefined && event.roadKm !== null && event.roadKm !== undefined) return Math.abs(existing.roadKm - event.roadKm) <= 0.8;
    return true;
  }));
}

function enhanceAdvice(
  advice: StandbyAdvice,
  travelSites: TravelTimeSite[],
  travelSamples: Map<string, TravelTimeSample>,
  drips: DripSignal[],
  tempSpeeds: TemporarySpeedRestriction[],
  plannedEvents: TrafficEvent[],
  srtiEvents: TrafficEvent[],
  closureEvents: TrafficEvent[],
  baseEvents: TrafficEvent[],
): StandbyAdvice {
  const travel = travelTimeMetrics(advice, travelSites, travelSamples);
  const tempLimit = temporaryLimitForSegment(advice, tempSpeeds);
  const correction = adjustedSensorScoreForTemporaryLimit(advice, tempLimit);
  const hasTomTom = advice.reasons.some(reason => reason.startsWith("TomTom Traffic:"));
  const reasons = [...advice.reasons];

  let score = Math.max(0, advice.score - correction.scoreReduction);
  let congestionIndex = Math.max(0, advice.congestionIndex - correction.congestionReduction);
  let corroboratingSignals = advice.corroboratingSignals;
  let confidence = advice.confidence;
  let supplementalScore = -correction.scoreReduction;

  if (tempLimit !== null) {
    if (correction.scoreReduction > 0) {
      reasons.push(`Tijdelijke NDW-maximumsnelheid ${tempLimit} km/u: detectorbeeld gecorrigeerd zodat normaal verkeer binnen de maatregel niet als file wordt overschat.`);
    } else {
      reasons.push(`Tijdelijke NDW-maximumsnelheid op dit wegvak: ${tempLimit} km/u.`);
    }
  }

  if (travel.sampleCount > 0 && travel.averageSpeedKph !== null) {
    const quality = travel.quality !== null ? ` · kwaliteit ${travel.quality}%` : "";
    const fcd = travel.fcdCount > 0 ? `, waarvan ${travel.fcdCount} FCD-traject(en)` : "";
    reasons.push(`NDW reistijden: ${travel.sampleCount} actueel traject(en)${fcd}, afgeleide snelheid ${travel.averageSpeedKph} km/u${quality}.`);

    if (travel.congested) {
      corroboratingSignals = clamp(corroboratingSignals + 1, 0, 6);
      if (advice.sensorCount === 0 && !hasTomTom) {
        score += travel.score;
        supplementalScore += travel.score;
        congestionIndex = Math.max(congestionIndex, Math.min(85, Math.round(travel.score / 24 * 85)));
        confidence = elevateConfidence(confidence, corroboratingSignals >= 2 ? "hoog" : "middel");
        reasons.push("Geen fysieke meetlus op dit wegdeel: NDW reistijd/FCD vult hier zelfstandig de ontbrekende live verkeersdrukcomponent in.");
      } else if (advice.sensorCount === 0 && hasTomTom) {
        const bonus = Math.min(3, Math.max(1, Math.round(travel.score / 8)));
        score += bonus;
        supplementalScore += bonus;
        confidence = elevateConfidence(confidence, "middel");
        reasons.push("NDW reistijd/FCD bevestigt de externe flowmeting; alleen een kleine bevestigingsbonus toegepast om dubbeltelling te voorkomen.");
      } else if (advice.congestionIndex >= 25) {
        const bonus = Math.min(4, Math.max(1, Math.round(travel.score / 6)));
        score += bonus;
        supplementalScore += bonus;
        confidence = elevateConfidence(confidence, corroboratingSignals >= 2 ? "hoog" : "middel");
        reasons.push("Fysieke NDW-detectoren en NDW reistijd/FCD laten onafhankelijk hetzelfde vertragingsbeeld zien.");
      } else {
        reasons.push("NDW reistijd/FCD ziet meer vertraging dan de lokale meetlus; daarom als controle-signaal gebruikt en niet volledig dubbel opgeteld.");
      }
    }
  }

  const independentPressure = congestionIndex >= 25 || advice.matrixClusters > 0 || advice.localEvents > 0 || travel.congested;
  const drip = dripMetrics(advice, drips, independentPressure);
  if (drip.count > 0) {
    reasons.push(`RWS/NDW DRIP bevestigt verkeershinder op ${advice.road}: “${drip.strongest?.text ?? "actuele verkeersmelding"}”.`);
    if (drip.score > 0) {
      score += drip.score;
      supplementalScore += drip.score;
      corroboratingSignals = clamp(corroboratingSignals + 1, 0, 6);
    }
  }

  const planning = plannedMetrics(advice, plannedEvents);
  if (planning.count > 0) {
    score += planning.score;
    supplementalScore += planning.score;
    const next = planning.items.slice().sort((a, b) => Date.parse(a.startsAt ?? "") - Date.parse(b.startsAt ?? ""))[0];
    reasons.push(`Vooruitkijkend NDW-signaal: ${planning.count} geplande maatregel(en) op dit wegvak${next?.startsAt ? `, eerstvolgende rond ${timeLabel(next.startsAt)}` : ""}.`);
  }

  const newSrti = newDedicatedEventsForSegment(advice, baseEvents, srtiEvents);
  const newClosures = newDedicatedEventsForSegment(advice, baseEvents, closureEvents);
  const newlyDiscovered = [...newSrti, ...newClosures];
  if (newlyDiscovered.length > 0) {
    const extra = newlyDiscovered.some(event => event.kind === "closure" || event.kind === "accident") ? 4 : 2;
    score += extra;
    supplementalScore += extra;
    corroboratingSignals = clamp(corroboratingSignals + 1, 0, 6);
    reasons.push(`Dedicated NDW-feed vond ${newlyDiscovered.length} relevante actuele situatie(s) die niet in de bestaande Actueel-Beeld-match zat; conservatief ${extra} punt(en) toegevoegd.`);
  }

  const srtiConfirmed = hasMatchingEvent(advice, srtiEvents) && eventOverlap(advice, baseEvents).length > 0;
  if (srtiConfirmed) reasons.push("Actuele situatie is ook teruggevonden in de dedicated NDW-SRTI-feed; gebruikt als herkomstcontrole, niet als dubbele scorebron.");

  score = clamp(Math.round(score), 0, 96);
  const pressure: StandbyAdvice["pressure"] = score >= 65 ? "hoog" : score >= 38 ? "verhoogd" : "rustig";
  const recommendedUnits = score >= 72 && confidence !== "laag" ? 2 : score >= 38 ? 1 : 0;

  return {
    ...advice,
    score,
    pressure,
    confidence,
    recommendedUnits,
    congestionIndex,
    corroboratingSignals,
    corroboratingSignalMax: 6,
    reasons,
    travelTimeSampleCount: travel.sampleCount,
    fcdAverageSpeedKph: travel.averageSpeedKph,
    temporarySpeedLimitKph: tempLimit,
    dripSignalCount: drip.count,
    plannedEventCount: planning.count,
    srtiConfirmed,
    supplementalScore,
  };
}

export async function GET() {
  const generatedAt = new Date().toISOString();
  let base: LiveRadarData;
  let supplemental: StaticSupplemental;

  try {
    const [baseResponse, staticResult] = await Promise.all([getExistingLive(), getSupplementalStatic()]);
    base = await baseResponse.json() as LiveRadarData;
    supplemental = staticResult;
  } catch (error) {
    try {
      const baseResponse = await getExistingLive();
      base = await baseResponse.json() as LiveRadarData;
      return NextResponse.json({
        ...base,
        sources: [...base.sources, makeSource("ndw-supplemental", "NDW extra verkeersbronnen", false, null, error instanceof Error ? error.message : "Initialisatie mislukt", "NDW Open Data aanvullende feeds")],
        meta: { ...base.meta, modelVersion: "1.0-ndw-multisource-fallback", note: `${base.meta.note} De aanvullende NDW-laag kon bij deze refresh niet initialiseren; bestaande live analyse blijft actief.` },
      }, { headers: { "Cache-Control": "no-store, max-age=0" } });
    } catch {
      throw error;
    }
  }

  const scopedTravelSites = supplemental.travelSites.filter(site => base.meta.roads.includes(site.road) && base.advice.some(advice => advice.road === site.road && site.kmFrom < advice.kmTo && site.kmTo > advice.kmFrom));

  const [travelResult, dripResult, srtiResult, closureResult, tempSpeedResult, bridgeResult, planningResult] = await Promise.all([
    fetchTravelTimes(scopedTravelSites),
    fetchDrip(),
    fetchSituationEvents(URLS.srti, supplemental.roadPoints),
    fetchSituationEvents(URLS.closures, supplemental.roadPoints),
    fetchTemporarySpeeds(supplemental.roadPoints),
    fetchPlannedFeed(URLS.bridges, supplemental.roadPoints, "NDW brugopeningen", 3, LIVE_TIMEOUT),
    getPlanning(supplemental.roadPoints),
  ]);

  const scopeEvents = (items: TrafficEvent[]) => items.flatMap(event => {
    const scoped = scopeEventToAdvice(event, base.advice);
    return scoped ? [scoped] : [];
  });
  const srtiEvents = scopeEvents(srtiResult.value);
  const closureEvents = scopeEvents(closureResult.value);
  const bridgeEvents = scopeEvents(bridgeResult.value);
  const plannedEvents = scopeEvents(planningResult.events);

  const relevantDrips = dripResult.value.filter(signal => signal.roads.some(road => base.meta.roads.includes(road)));
  const relevantTempSpeeds = tempSpeedResult.value.filter(item => base.meta.roads.includes(item.road) && base.advice.some(advice => advice.road === item.road && item.kmFrom < advice.kmTo && item.kmTo > advice.kmFrom));
  const allPlanned = mergeUniqueEvents([plannedEvents, bridgeEvents]);
  const mergedEvents = mergeUniqueEvents([base.events, srtiEvents, closureEvents, plannedEvents, bridgeEvents]);

  const advice = base.advice
    .map(item => enhanceAdvice(item, scopedTravelSites, travelResult.value, relevantDrips, relevantTempSpeeds, allPlanned, srtiEvents, closureEvents, base.events))
    .sort((a, b) => b.score - a.score || b.corroboratingSignals - a.corroboratingSignals || a.road.localeCompare(b.road, "nl", { numeric: true }));

  const sourceStatus: SourceStatus[] = [
    makeSource(
      "ndw-traveltime",
      "NDW reistijden / FCD",
      !travelResult.error && scopedTravelSites.length > 0,
      travelResult.updatedAt ?? supplemental.travelConfigUpdatedAt,
      travelResult.error ?? supplemental.travelConfigError ?? (scopedTravelSites.length ? null : "Geen reistijdtrajecten binnen huidige IM-segmenten gevonden"),
      "NDW reistijdtrajecten · ANPR/lussen/Bluetooth/Floating Car Data",
    ),
    makeSource("ndw-drip", "NDW/RWS DRIP", !dripResult.error, dripResult.updatedAt, dripResult.error, "Actuele teksten op dynamische route-informatiepanelen"),
    makeSource("ndw-srti", "NDW SRTI", !srtiResult.error, srtiResult.updatedAt, srtiResult.error, "Safety Related Traffic Information · overlap met Actueel Beeld wordt niet dubbel gescoord"),
    makeSource("ndw-planning", "NDW werkzaamheden + evenementen", !planningResult.error, planningResult.updatedAt, planningResult.error, "Planningfeed · horizon 6 uur · overlap met Actueel Beeld wordt gededupliceerd"),
    makeSource("ndw-temp-closures", "NDW tijdelijke afsluitingen", !closureResult.error, closureResult.updatedAt, closureResult.error, "Tijdelijke verkeersmaatregelen · afsluitingen"),
    makeSource("ndw-temp-speed", "NDW tijdelijke maximumsnelheid", !tempSpeedResult.error, tempSpeedResult.updatedAt, tempSpeedResult.error, "Tijdelijke maximumsnelheden · gebruikt om detectorbeeld te normaliseren"),
    makeSource("ndw-bridges", "NDW brugopeningen", !bridgeResult.error, bridgeResult.updatedAt, bridgeResult.error, "Geplande brugopeningen met verkeersstremming · horizon 3 uur"),
  ];

  const fcdCoverageSegments = advice.filter(item => (item.travelTimeSampleCount ?? 0) > 0).length;
  const note = `${base.meta.note} Extra NDW-fusion actief: reistijden/FCD, DRIP, SRTI, werkzaamheden/evenementen, tijdelijke afsluitingen, tijdelijke maximumsnelheden en brugopeningen. Actueel Beeld bevat een deel van deze NDW-situaties al; dezelfde situatie wordt daarom gededupliceerd en niet als onafhankelijke bron dubbel gescoord. Tijdelijke snelheidslimieten normaliseren het detectorbeeld.`;

  return NextResponse.json({
    ...base,
    generatedAt,
    events: mergedEvents,
    advice,
    sources: [...base.sources.filter(source => !source.id.startsWith("ndw-") || !["ndw-traveltime", "ndw-drip", "ndw-srti", "ndw-planning", "ndw-temp-closures", "ndw-temp-speed", "ndw-bridges"].includes(source.id)), ...sourceStatus],
    meta: {
      ...base.meta,
      eventCount: mergedEvents.length,
      accidentCount: mergedEvents.filter(event => event.kind === "accident").length,
      obstructionCount: mergedEvents.filter(event => event.kind === "obstruction").length,
      trafficCount: mergedEvents.filter(event => event.kind === "traffic").length,
      closureCount: mergedEvents.filter(event => event.kind === "closure").length,
      modelVersion: "1.0-ndw-multisource-fusion",
      travelTimeSiteCount: scopedTravelSites.length,
      travelTimeSampleCount: travelResult.value.size,
      fcdCoverageSegments,
      dripSignalCount: relevantDrips.length,
      plannedEventCount: plannedEvents.length,
      temporarySpeedRestrictionCount: relevantTempSpeeds.length,
      srtiEventCount: srtiEvents.length,
      bridgeEventCount: bridgeEvents.length,
      note,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
