import { NextResponse } from "next/server";
import { GET as getFusionLive } from "../live-fusion/route";
import { GET as getHistory } from "../history/route";
import type { HistoricalBaseline, LiveRadarData, RoadDirection, SourceStatus, StandbyAdvice, TrafficEvent, WeatherSnapshot } from "@/lib/types";
import type { ImnRoadRange } from "@/lib/rayons";
import type { RoadMetringPoint } from "@/lib/ndw";
import { matrixSummary } from "@/lib/ndw";
import { haversineKm, normalizeRoadDirection, segmentEvents, segmentMatrix, sensorMetrics, weatherScore, type CandidateLocation, type Segment } from "@/lib/engine-v2";
import { travelTimeMetricsV2 } from "@/lib/ndw-traveltime-v2";
import { exactRange, loadV5Live, loadV5Static, type V5StaticContext } from "@/lib/live-v5-data";
import { baselineKey, historyConfigured, loadCurrentBaselines, saveRadarSnapshot } from "@/lib/history-store";
import { consensusForAdvice, incidentRiskForAdvice } from "@/lib/reliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SEGMENT_LENGTH_KM = 5;
const MODEL_VERSION = "2.0-directional-reliability";
const ARNHEM_NIJMEGEN_CENTER = { lat: 51.9, lng: 5.84 };
const ARNHEM_NIJMEGEN_RADIUS_KM = 42;
const ARNHEM_NIJMEGEN_STANDBY_SEARCH_KM = 30;
const ARNHEM_NIJMEGEN_ROADS = new Set(["A12", "A15", "A50", "A73", "A325", "A326", "A348"]);

const locationQuality = (location: CandidateLocation) => location.kind === "service_area" ? 18 : location.kind === "fuel" ? 17 : location.kind === "parking" ? 15 : 10;

function buildDirectionalSegments(context: V5StaticContext): Segment[] {
  type Bucket = { rayon: string; road: string; direction: RoadDirection; bucketFrom: number; kmFrom: number; kmTo: number };
  const buckets = new Map<string, Bucket>();
  for (const range of context.ranges) {
    const direction = normalizeRoadDirection(range.direction);
    let bucketFrom = Math.floor(range.fromKm / SEGMENT_LENGTH_KM) * SEGMENT_LENGTH_KM;
    while (bucketFrom < range.toKm) {
      const kmFrom = Math.max(bucketFrom, range.fromKm);
      const kmTo = Math.min(bucketFrom + SEGMENT_LENGTH_KM, range.toKm);
      if (kmTo > kmFrom) {
        const key = `${range.rayon}:${range.road}:${direction ?? "B"}:${bucketFrom}`;
        const existing = buckets.get(key);
        if (existing) {
          existing.kmFrom = Math.min(existing.kmFrom, kmFrom);
          existing.kmTo = Math.max(existing.kmTo, kmTo);
        } else buckets.set(key, { rayon: range.rayon, road: range.road, direction, bucketFrom, kmFrom, kmTo });
      }
      bucketFrom += SEGMENT_LENGTH_KM;
    }
  }

  const segments: Segment[] = [];
  for (const bucket of buckets.values()) {
    const sites = context.sites.filter(site => {
      if (site.rayon !== bucket.rayon || site.road !== bucket.road || site.km < bucket.kmFrom || site.km > bucket.kmTo) return false;
      const direction = normalizeRoadDirection(site.direction);
      return !bucket.direction || !direction || direction === bucket.direction;
    });
    const points = context.roadPoints.filter(point => {
      if (point.road !== bucket.road || point.km < bucket.kmFrom || point.km > bucket.kmTo) return false;
      const direction = normalizeRoadDirection(point.direction);
      if (bucket.direction && direction && bucket.direction !== direction) return false;
      const range = exactRange(point.road, point.km, direction, context.ranges);
      return range?.rayon === bucket.rayon;
    });
    const centerKm = (bucket.kmFrom + bucket.kmTo) / 2;
    const representative = points.slice().sort((a, b) => Math.abs(a.km - centerKm) - Math.abs(b.km - centerKm))[0];
    const lat = representative?.lat ?? (sites.length ? sites.reduce((sum, site) => sum + site.lat, 0) / sites.length : null);
    const lng = representative?.lng ?? (sites.length ? sites.reduce((sum, site) => sum + site.lng, 0) / sites.length : null);
    if (lat === null || lng === null) continue;
    const wvkIds = [...new Set([
      ...points.map(point => point.wvkId),
      ...sites.map(site => site.wvkId ?? null),
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value)))];
    segments.push({
      rayon: bucket.rayon,
      road: bucket.road,
      direction: bucket.direction,
      kmFrom: Math.round(bucket.kmFrom * 10) / 10,
      kmTo: Math.round(bucket.kmTo * 10) / 10,
      centerKm,
      lat,
      lng,
      wvkIds,
      sites,
    });
  }
  return segments.sort((a, b) => a.road.localeCompare(b.road, "nl", { numeric: true }) || a.kmFrom - b.kmFrom || (a.direction ?? "").localeCompare(b.direction ?? "") || a.rayon.localeCompare(b.rayon, "nl", { numeric: true }));
}

const segmentId = (segment: Segment) => `${segment.rayon}-${segment.road}-${segment.direction ?? "B"}-${segment.kmFrom}-${segment.kmTo}`;

function nearestPoint(event: TrafficEvent, points: RoadMetringPoint[]) {
  let best: { point: RoadMetringPoint; distanceKm: number } | null = null;
  for (const point of points) {
    if (event.roadRef && point.road !== event.roadRef) continue;
    const distanceKm = haversineKm(event, point);
    if (distanceKm > .8) continue;
    if (!best || distanceKm < best.distanceKm) best = { point, distanceKm };
  }
  return best;
}

function remapEvents(events: TrafficEvent[], context: V5StaticContext) {
  return events.flatMap(event => {
    const mapped = nearestPoint(event, context.roadPoints);
    if (!mapped) return event.roadRef && event.rayon ? [{ ...event, direction: event.direction ?? null }] : [];
    const direction = normalizeRoadDirection(mapped.point.direction);
    const range = exactRange(mapped.point.road, mapped.point.km, direction, context.ranges);
    if (!range) return [];
    return [{
      ...event,
      roadRef: mapped.point.road,
      roadKm: mapped.point.km,
      direction,
      wvkId: mapped.point.wvkId,
      mappingDistanceMeters: Math.round(mapped.distanceKm * 1000),
      rayon: range.rayon,
    }];
  });
}

function baseAdviceFor(segment: Segment, base: StandbyAdvice[]) {
  return base.filter(item => item.road === segment.road && item.kmFrom < segment.kmTo && item.kmTo > segment.kmFrom && item.rayon === segment.rayon)
    .sort((a, b) => Math.abs((a.kmFrom + a.kmTo) / 2 - segment.centerKm) - Math.abs((b.kmFrom + b.kmTo) / 2 - segment.centerKm))[0] ?? null;
}

function historyScore(segment: Segment, history: Array<{ road: string; kmFrom: number; kmTo: number; historyScore: number }>) {
  const values = history.filter(item => item.road === segment.road && item.kmFrom < segment.kmTo && item.kmTo > segment.kmFrom).map(item => item.historyScore);
  return values.length ? Math.max(...values) : 0;
}

function routeStandby(segment: Segment, context: V5StaticContext, chosen: CandidateLocation[]) {
  const inArnhemNijmegen = ARNHEM_NIJMEGEN_ROADS.has(segment.road)
    && haversineKm(segment, ARNHEM_NIJMEGEN_CENTER) <= ARNHEM_NIJMEGEN_RADIUS_KM;
  const candidates = context.candidates.filter(candidate =>
    candidate.rayon === segment.rayon
    || (inArnhemNijmegen && haversineKm(segment, candidate) <= ARNHEM_NIJMEGEN_STANDBY_SEARCH_KM),
  );
  const routed = candidates.flatMap(candidate => {
    const reused = chosen.some(item => item.id === candidate.id);
    const overlap = chosen.some(item => item.road === candidate.road && normalizeRoadDirection(item.direction) === normalizeRoadDirection(candidate.direction) && Math.abs(item.accessKm - candidate.accessKm) < 8);
    const crossRayonPenalty = candidate.rayon === segment.rayon ? 0 : 4;
    const sameRoadBonus = candidate.road === segment.road ? 2 : 0;
    if (context.graph && candidate.wvkId && segment.wvkIds.length) {
      const routes = segment.wvkIds.map(wvkId => context.graph!.route(candidate.wvkId!, wvkId, 80)).filter(route => route.reachable && route.distanceKm !== null && route.etaMinutes !== null);
      routes.sort((a, b) => (a.etaMinutes ?? Infinity) - (b.etaMinutes ?? Infinity));
      const route = routes[0];
      if (!route || (route.etaMinutes ?? Infinity) > 25) return [];
      return [{
        location: { ...candidate, routeDistanceKm: route.distanceKm, routeEtaMinutes: route.etaMinutes, routeVerified: true },
        roadDistance: Math.abs(candidate.accessKm - segment.centerKm),
        rank: locationQuality(candidate) + sameRoadBonus - (route.etaMinutes ?? 25) * 1.1 - crossRayonPenalty - (reused ? 18 : 0) - (overlap ? 5 : 0),
      }];
    }
    const candidateDirection = normalizeRoadDirection(candidate.direction);
    if (candidate.road !== segment.road || (segment.direction && candidateDirection && segment.direction !== candidateDirection)) return [];
    const roadDistance = Math.abs(candidate.accessKm - segment.centerKm);
    if (roadDistance > 15) return [];
    const eta = Math.max(2, roadDistance / 90 * 60 + 1.5);
    return [{
      location: { ...candidate, routeDistanceKm: Math.round(roadDistance * 10) / 10, routeEtaMinutes: Math.round(eta * 10) / 10, routeVerified: false },
      roadDistance,
      rank: locationQuality(candidate) + sameRoadBonus - eta * 1.2 - crossRayonPenalty - (segment.direction && !candidateDirection ? 8 : 0) - (reused ? 18 : 0) - (overlap ? 5 : 0),
    }];
  }).sort((a, b) => b.rank - a.rank || (a.location.routeEtaMinutes ?? Infinity) - (b.location.routeEtaMinutes ?? Infinity));
  return routed[0] ?? null;
}

function tempLimitCorrection(speed: number | null, sensorScore: number, congestionIndex: number, limit: number | null) {
  if (!limit || speed === null) return { score: sensorScore, congestion: congestionIndex, reduction: 0 };
  const ratio = speed / limit;
  const reduction = ratio >= .9 ? Math.min(8, sensorScore) : ratio >= .78 ? Math.min(4, sensorScore) : 0;
  const congestionReduction = ratio >= .9 ? Math.min(20, congestionIndex) : ratio >= .78 ? Math.min(10, congestionIndex) : 0;
  return { score: sensorScore - reduction, congestion: congestionIndex - congestionReduction, reduction };
}

function baselineFor(segment: Segment, baselines: Map<string, HistoricalBaseline>) {
  const key = `${segment.road}:${segment.direction ?? "?"}:${segment.kmFrom.toFixed(1)}:${segment.kmTo.toFixed(1)}`;
  return baselines.get(key) ?? null;
}

const makeSource = (id: string, name: string, ok: boolean, updatedAt: string | null, error: string | null, lineage: string): SourceStatus => ({ id, name, ok, updatedAt, error, lineage });

export async function GET() {
  const generatedAt = new Date().toISOString();
  const [baseResult, staticResult, historyResult] = await Promise.allSettled([getFusionLive(), loadV5Static(), getHistory()]);
  if (baseResult.status !== "fulfilled" || staticResult.status !== "fulfilled") {
    if (baseResult.status === "fulfilled") {
      const fallback = await baseResult.value.json() as LiveRadarData;
      return NextResponse.json({ ...fallback, meta: { ...fallback.meta, modelVersion: "2.0-directional-fallback", note: `${fallback.meta.note} Directionele v2-engine kon niet volledig initialiseren; de bewezen 1.0-engine blijft actief.` } }, { headers: { "Cache-Control": "no-store, max-age=0" } });
    }
    return NextResponse.json({ error: "Geen bruikbare live basis beschikbaar" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const base = await baseResult.value.json() as LiveRadarData;
  const context = staticResult.value;
  const live = await loadV5Live(context);
  const segments = buildDirectionalSegments(context);
  const events = remapEvents(base.events, context);
  let historicalSegments: Array<{ road: string; kmFrom: number; kmTo: number; historyScore: number }> = [];
  if (historyResult.status === "fulfilled") {
    const historyJson = await historyResult.value.json() as { segments?: Array<{ road: string; kmFrom: number; kmTo: number; historyScore: number }> };
    historicalSegments = historyJson.segments ?? [];
  }

  let baselines = new Map<string, HistoricalBaseline>();
  if (historyConfigured()) {
    try { baselines = await loadCurrentBaselines(); } catch { baselines = new Map(); }
  }

  const scored = segments.map(segment => {
    const msi = segmentMatrix(live.matrix, segment);
    const sensor = sensorMetrics(segment, live.samples, msi.closedLaneCount);
    const incident = segmentEvents(segment, events);
    const travel = travelTimeMetricsV2(segment, context.travelSites, live.travelSamples);
    const legacy = baseAdviceFor(segment, base.advice);
    const localWeather: WeatherSnapshot | null = legacy?.weather ?? null;
    const tempLimit = legacy?.temporarySpeedLimitKph ?? null;
    const corrected = tempLimitCorrection(sensor.averageSpeedKph, sensor.score, sensor.congestionIndex, tempLimit);
    const weatherPoints = weatherScore(localWeather);
    const independentTraffic = [corrected.congestion >= 25, travel.congested, msi.clusters > 0].filter(Boolean).length;
    const eventSignal = incident.items.length > 0;
    const corroborating = independentTraffic + (eventSignal ? 1 : 0) + ((legacy?.dripSignalCount ?? 0) > 0 ? 1 : 0);
    let score = corrected.score + msi.score + incident.score + weatherPoints;
    if (travel.sampleCount > 0) {
      if (sensor.sensorCount === 0) score += travel.score;
      else if (travel.congested && corrected.congestion >= 25) score += Math.min(4, Math.max(1, Math.round(travel.score / 6)));
    }
    if (corroborating >= 2) score += 4;
    if (sensor.sensorCount === 0 && travel.sampleCount === 0) score = Math.min(score, 45);
    if (corroborating <= 1) score = Math.min(score, 52);
    score = Math.max(0, Math.min(96, Math.round(score)));
    return { segment, msi, sensor, incident, travel, legacy, localWeather, tempLimit, corrected, weatherPoints, corroborating, score };
  }).sort((a, b) => b.score - a.score || b.corroborating - a.corroborating);

  const chosen: CandidateLocation[] = [];
  const advice: StandbyAdvice[] = [];
  for (const item of scored) {
    const routed = routeStandby(item.segment, context, chosen);
    if (!routed) continue;
    chosen.push(routed.location);
    const pressure: StandbyAdvice["pressure"] = item.score >= 65 ? "hoog" : item.score >= 38 ? "verhoogd" : "rustig";
    const quality = item.sensor.qualityScore ?? 0;
    const confidence: StandbyAdvice["confidence"] = item.sensor.sensorCount >= 2 && quality >= 60 && item.corroborating >= 2
      ? "hoog"
      : (item.sensor.sensorCount >= 1 || item.travel.sampleCount >= 2) && item.corroborating >= 1 ? "middel" : "laag";
    const maxSnap = item.segment.sites.length ? Math.max(...item.segment.sites.map(site => site.mappingDistanceMeters)) : 0;
    const routeText = routed.location.routeVerified
      ? `NWB-route gevalideerd: circa ${routed.location.routeDistanceKm} km / ${routed.location.routeEtaMinutes} min vanaf stand-byplek`
      : `route niet volledig topologisch gevalideerd; conservatieve zelfde-rijbaan schatting ${routed.location.routeEtaMinutes} min`;
    const reasons = [
      `${item.segment.rayon} · ${item.segment.road} ${item.segment.direction ?? "richting onbekend"} km ${item.segment.kmFrom}–${item.segment.kmTo}: exact IM-contractwegdeel`,
      item.sensor.sensorCount
        ? `${item.sensor.sensorCount} bruikbare fysieke detector(en) op deze rijrichting; ${item.sensor.rejectedSensorCount} afgekeurd/uitbijter; kwaliteit ${item.sensor.qualityScore ?? "—"}% · ${item.sensor.averageSpeedKph ?? "—"} km/u${item.sensor.flowVehiclesPerHour !== null ? ` · ${item.sensor.flowVehiclesPerHour} vtg/u` : ""}${item.sensor.flowPerLane !== null ? ` · ${item.sensor.flowPerLane} vtg/u/rijstrook` : ""}`
        : "geen betrouwbare fysieke detector op deze rijrichting",
      item.sensor.sensorCount ? `RWS-metrering exact op ${item.segment.direction ?? "onbekende"} rijbaan; max. detectorsnap ${maxSnap} m` : null,
      item.msi.clusters ? `${item.msi.clusters} directioneel passend matrixcluster(s), ${item.msi.closedLaneCount} afgesloten rijstrook/rijstroken verwerkt in effectieve capaciteit` : "geen actieve matrixmaatregel op deze rijrichting",
      item.travel.sampleCount ? `NDW reistijden/FCD v2: ${item.travel.sampleCount} bruikbare traject(en), ${item.travel.fcdCount} FCD; ${item.travel.averageSpeedKph ?? "—"} km/u; kwaliteit ${item.travel.qualityScore ?? "—"}%${item.travel.fcdCount ? ` (beschikbaarheid ${item.travel.availability ?? "—"}%, tijdigheid ${item.travel.timeliness ?? "—"}%, dekking ${item.travel.coverage ?? "—"}%)` : ""}` : "geen voldoende betrouwbare directionele reistijd/FCD-match",
      item.tempLimit ? `tijdelijke maximumsnelheid ${item.tempLimit} km/u meegenomen; ${item.corrected.reduction ? `${item.corrected.reduction} overschattingspunt(en) uit detectorscore verwijderd` : "geen correctie nodig"}` : null,
      item.incident.accidents ? `${item.incident.accidents} actueel ongeval(len) directioneel passend` : null,
      item.incident.obstructions ? `${item.incident.obstructions} actuele blokkade(s)/obstakels directioneel passend` : null,
      (item.legacy?.dripSignalCount ?? 0) > 0 ? `${item.legacy?.dripSignalCount} DRIP-signaal/signalen op dit wegvak als aanvullende bevestiging` : null,
      (item.legacy?.plannedEventCount ?? 0) > 0 ? `${item.legacy?.plannedEventCount} geplande maatregel(en) binnen huidige horizon` : null,
      item.legacy?.srtiConfirmed ? "actuele situatie door dedicated SRTI-bron bevestigd; niet dubbel gescoord" : null,
      routeText,
    ].filter((reason): reason is string => Boolean(reason));

    const preliminary: StandbyAdvice = {
      id: segmentId(item.segment), rayon: item.segment.rayon, road: item.segment.road, direction: item.segment.direction, wvkIds: item.segment.wvkIds,
      segmentName: `${item.segment.rayon} · ${item.segment.road} ${item.segment.direction ?? ""} km ${item.segment.kmFrom}–${item.segment.kmTo}`.replace(/\s+/g, " "),
      kmFrom: item.segment.kmFrom, kmTo: item.segment.kmTo, score: item.score, pressure, confidence,
      recommendedUnits: item.score >= 72 && confidence !== "laag" ? 2 : item.score >= 38 ? 1 : 0,
      sensorCount: item.sensor.sensorCount, rejectedSensorCount: item.sensor.rejectedSensorCount, sensorQualityScore: item.sensor.qualityScore,
      laneCount: item.sensor.laneCount, effectiveLaneCount: item.sensor.effectiveLaneCount, flowPerLane: item.sensor.flowPerLane,
      averageSpeedKph: item.sensor.averageSpeedKph, flowVehiclesPerHour: item.sensor.flowVehiclesPerHour, congestionIndex: item.corrected.congestion,
      localEvents: item.incident.items.length, accidents: item.incident.accidents, obstructions: item.incident.obstructions,
      matrixClusters: item.msi.clusters, lowSpeedMatrixClusters: item.msi.lowSpeed, corroboratingSignals: item.corroborating, corroboratingSignalMax: 6,
      reasons, weather: item.localWeather,
      standby: {
        id: routed.location.id, name: routed.location.name, address: routed.location.address, lat: routed.location.lat, lng: routed.location.lng,
        kind: routed.location.kind, source: routed.location.source, verified: routed.location.verified, direction: normalizeRoadDirection(routed.location.direction),
        road: routed.location.road, accessKm: routed.location.accessKm, wvkId: routed.location.wvkId ?? null,
        routeDistanceKm: routed.location.routeDistanceKm ?? null, routeEtaMinutes: routed.location.routeEtaMinutes ?? null, routeVerified: routed.location.routeVerified ?? false,
      },
      travelTimeSampleCount: item.travel.sampleCount, fcdAverageSpeedKph: item.travel.averageSpeedKph, fcdQualityScore: item.travel.qualityScore,
      fcdAvailability: item.travel.availability, fcdTimeliness: item.travel.timeliness, fcdCoverage: item.travel.coverage,
      temporarySpeedLimitKph: item.tempLimit, dripSignalCount: item.legacy?.dripSignalCount ?? 0, plannedEventCount: item.legacy?.plannedEventCount ?? 0,
      srtiConfirmed: item.legacy?.srtiConfirmed ?? false, supplementalScore: item.legacy?.supplementalScore ?? 0,
      routeDistanceKm: routed.location.routeDistanceKm ?? null, routeEtaMinutes: routed.location.routeEtaMinutes ?? null, routeVerified: routed.location.routeVerified ?? false,
    };
    const baseline = baselineFor(item.segment, baselines);
    const consensus = consensusForAdvice(preliminary);
    const risk = incidentRiskForAdvice({ ...preliminary, consensus }, historyScore(item.segment, historicalSegments), baseline);
    const finalConfidence: StandbyAdvice["confidence"] = risk.reliabilityScore >= 78 && !risk.consensus.conflict ? "hoog" : risk.reliabilityScore >= 50 ? "middel" : "laag";
    advice.push({
      ...preliminary,
      confidence: finalConfidence,
      recommendedUnits: risk.incidentRisk30 >= 78 && finalConfidence !== "laag" ? 2 : risk.incidentRisk30 >= 45 ? 1 : 0,
      trafficPressureScore: risk.trafficPressureScore,
      incidentRisk30: risk.incidentRisk30,
      incidentRisk60: risk.incidentRisk60,
      reliabilityScore: risk.reliabilityScore,
      consensus: risk.consensus,
      baseline,
      reasons: [...reasons, risk.consensus.conflict ? `BRONCONFLICT: verkeersbronnen verschillen ${risk.consensus.spread} punten; betrouwbaarheid bewust verlaagd.` : `${risk.consensus.agreeingFamilies} onafhankelijke verkeersbronfamilie(s) liggen binnen consensusmarge; betrouwbaarheid ${risk.reliabilityScore}%.`, baseline?.mature ? `historische kwartierbaseline actief met ${baseline.sampleCount} eigen metingen.` : "historische eigen baseline nog in opbouw."],
    });
  }

  advice.sort((a, b) => (b.incidentRisk30 ?? b.score) - (a.incidentRisk30 ?? a.score) || (b.reliabilityScore ?? 0) - (a.reliabilityScore ?? 0));
  const sourceUpdates: SourceStatus[] = [
    makeSource("ndw-flow-v2", "NDW detectoren v2", live.samples.size > 0, live.trafficUpdatedAt, live.errors.find(error => error.startsWith("NDW detectoren")) ?? null, "Directioneel · kwaliteitsfilter · outliercontrole · capaciteit per rijstrook"),
    makeSource("rws-matrix-v2", "RWS matrix v2", true, live.matrixUpdatedAt, live.errors.find(error => error.startsWith("RWS matrix")) ?? null, "Directioneel per rijbaan en rijstrook"),
    makeSource("ndw-traveltime-v2", "NDW reistijden/FCD v2", live.travelSamples.size > 0, live.travelUpdatedAt ?? context.travelConfigUpdatedAt, live.errors.find(error => error.startsWith("NDW reistijd")) ?? context.errors.find(error => error.startsWith("NDW reistijdconfig")) ?? null, "FCD beschikbaarheid/tijdigheid/dekking semantisch gescheiden · directionele mapping"),
    makeSource("nwb-routing", "RWS NWB routering", Boolean(context.graph && context.nwbEdgeCount), context.nwbUpdatedAt, context.graph ? null : context.errors.find(error => error.includes("NWB")) ?? "Geen routegraph", "WVK_ID + begin/eindjuncties + officiële rijrichting"),
    makeSource("radar-history", "Standby Radar eigen historie", historyConfigured(), generatedAt, historyConfigured() ? null : "STANDBY_DATABASE_URL nog niet gekoppeld in Vercel", "Eigen kwartierbaseline, risicokalibratie en backtesting"),
  ];
  const sources = [...base.sources.filter(source => !["ndw-flow", "rws-matrix", "ndw-traveltime"].includes(source.id)), ...sourceUpdates];
  const matrixByRoad = matrixSummary(live.matrix);
  const activeSignals = matrixByRoad.reduce((sum, row) => sum + row.active, 0);
  const response: LiveRadarData = {
    ...base,
    generatedAt,
    events,
    advice,
    sources,
    matrix: { activeSignals, byRoad: matrixByRoad },
    meta: {
      ...base.meta,
      segmentCount: segments.length,
      directionSegmentCount: segments.length,
      measuredSiteCount: live.samples.size,
      candidateLocationCount: context.candidates.length,
      modelVersion: MODEL_VERSION,
      note: "Operationele v2-engine: IM-contractsegmenten zijn per Li/Re gescheiden. Fysieke detectoren worden op kwaliteit en uitbijters gevalideerd, intensiteit wordt waar betrouwbaar per effectieve rijstrook genormaliseerd, FCD-kwaliteit gebruikt afzonderlijk beschikbaarheid/tijdigheid/dekking, bronconflicten verlagen de betrouwbaarheid, verkeersdruk en incidentrisico 30/60 minuten zijn gescheiden, en stand-byroutering gebruikt waar mogelijk de officiële NWB-topologie. In Arnhem–Nijmegen blijven de wegdelen afzonderlijk gemonitord; voor stand-by mag de routering daar ook een officiële RWS-locatie in een aangrenzend rayon gebruiken wanneer die via NWB binnen 25 minuten bereikbaar is. Eigen kwartierbaselines en replay/backtests groeien zodra de beveiligde Standby Radar-databasevariabele in Vercel is gekoppeld.",
      fcdCoverageSegments: advice.filter(item => (item.travelTimeSampleCount ?? 0) > 0).length,
      travelTimeSampleCount: live.travelSamples.size,
      routeVerifiedCount: advice.filter(item => item.routeVerified).length,
      consensusConflictCount: advice.filter(item => item.consensus?.conflict).length,
      historyConfigured: historyConfigured(),
      baselineMatureSegments: advice.filter(item => item.baseline?.mature).length,
      backtestReady: false,
    },
  };
  if (historyConfigured()) {
    try { await saveRadarSnapshot(response, MODEL_VERSION); } catch { /* history may never break live advice */ }
  }
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
