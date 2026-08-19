import { createGunzip, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import type { RayonRoadOverlay, SourceStatus, StandbyAdvice, TrafficEvent, WeatherSnapshot } from "@/lib/types";
import type { MeasurementSite, RawMeasurementSite, RoadMetringPoint, SiteTraffic } from "@/lib/ndw";
import {
  mapMeasurementSites,
  matrixSummary,
  parseEvents,
  parseMatrix,
  parseRawMeasurementSites,
  parseRoadMetringPoints,
  parseTrafficSamples,
  stripTags,
  tagValue,
} from "@/lib/ndw";
import {
  buildSegments,
  chooseDynamicStandby,
  haversineKm,
  parseOsmCandidates,
  parseRwsVildCandidates,
  segmentEvents,
  segmentMatrix,
  sensorMetrics,
  weatherScore,
  type CandidateLocation,
  type ScopedMeasurementSite,
  type Segment,
} from "@/lib/engine";
import {
  findImnRange,
  normalizeDirection,
  parseImnRoadRanges,
  parseVanEijckRayonCodes,
  type ImnRoadRange,
} from "@/lib/rayons";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const URLS = {
  current: "https://opendata.ndw.nu/actueel_beeld.xml.gz",
  matrix: "https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz",
  traffic: "https://opendata.ndw.nu/trafficspeed.xml.gz",
  sites: "https://opendata.ndw.nu/measurement_current.xml.gz",
  rwsMetering: "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/nwb_metrering/MapServer/2/query",
  rwsVild: "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/vild/FeatureServer",
  imnContracts: "https://stichtingimn.nl/gecontracteerde-bergers-2023-2026.php",
  imnRayons: "https://www.stichtingimn.nl/rayons.php",
  overpass: "https://overpass-api.de/api/interpreter",
  weather: "https://api.open-meteo.com/v1/forecast",
};

const STATIC_TTL = 6 * 60 * 60 * 1000;
const BBOX = { minLat: 51.15, minLng: 4.20, maxLat: 52.30, maxLng: 6.55 };

type StaticContext = {
  expires: number;
  sites: ScopedMeasurementSite[];
  roadPoints: RoadMetringPoint[];
  scopedRoadPoints: RoadMetringPoint[];
  rayonCodes: string[];
  ranges: ImnRoadRange[];
  roadOverlays: RayonRoadOverlay[];
  rwsCandidates: CandidateLocation[];
  osmCandidates: CandidateLocation[];
  siteUpdatedAt: string | null;
  meteringUpdatedAt: string | null;
  imnUpdatedAt: string | null;
  rwsUpdatedAt: string | null;
  osmUpdatedAt: string | null;
  rwsError: string | null;
  osmError: string | null;
};

let staticCache: StaticContext | null = null;

const fetchText = async (url: string, revalidate: number) => {
  const response = await fetch(url, { next: { revalidate }, headers: { "user-agent": "StandbyRadar/0.6" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer[0] === 31 && buffer[1] === 139 ? gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
  return { text, updatedAt: response.headers.get("last-modified") ?? response.headers.get("date") };
};

async function streamGzipXmlRecords(url: string, recordName: string, onRecord: (record: string) => void) {
  const response = await fetch(url, { cache: "no-store", headers: { "user-agent": "StandbyRadar/0.6" } });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const input = Readable.fromWeb(response.body as never);
  const stream = input.pipe(createGunzip());
  const decoder = new TextDecoder();
  const startRegex = new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${recordName}\\b`, "i");
  const endRegex = new RegExp(`</(?:(?:[A-Za-z0-9_-]+):)?${recordName}>`, "i");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    while (true) {
      const startMatch = startRegex.exec(buffer);
      if (!startMatch) { if (buffer.length > 4096) buffer = buffer.slice(-4096); break; }
      const start = startMatch.index, remainder = buffer.slice(start), endMatch = endRegex.exec(remainder);
      if (!endMatch) { buffer = remainder; break; }
      const end = start + endMatch.index + endMatch[0].length;
      onRecord(buffer.slice(start, end));
      buffer = buffer.slice(end);
    }
  }
  return response.headers.get("last-modified") ?? response.headers.get("date");
}

async function fetchRawSitesStreaming() {
  const raw: RawMeasurementSite[] = [];
  const updatedAt = await streamGzipXmlRecords(URLS.sites, "measurementSiteRecord", record => {
    const parsed = parseRawMeasurementSites(record);
    if (parsed.length) raw.push(...parsed);
  });
  return { raw, updatedAt };
}

async function fetchTrafficStreaming(siteMap: Map<string, MeasurementSite>) {
  const samples: SiteTraffic[] = [];
  const updatedAt = await streamGzipXmlRecords(URLS.traffic, "siteMeasurements", record => {
    const parsed = parseTrafficSamples(record, siteMap);
    if (parsed.length) samples.push(...parsed);
  });
  return { samples, updatedAt };
}

async function fetchRoadPoints() {
  const all: RoadMetringPoint[] = [];
  let offset = 0, updatedAt: string | null = null;
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      where: "a_n_nr LIKE 'A%'", outFields: "a_n_nr,l_r,hectometer,hectomtrng", returnGeometry: "true",
      geometry: `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`, geometryType: "esriGeometryEnvelope",
      inSR: "4326", spatialRel: "esriSpatialRelIntersects", outSR: "4326", resultOffset: String(offset), resultRecordCount: "2000", f: "geojson",
    });
    const response = await fetch(`${URLS.rwsMetering}?${params}`, { next: { revalidate: 21600 }, headers: { "user-agent": "StandbyRadar/0.6" } });
    if (!response.ok) throw new Error(`RWS metrering HTTP ${response.status}`);
    updatedAt = response.headers.get("last-modified") ?? response.headers.get("date") ?? updatedAt;
    const json = await response.json() as { features?: unknown[] };
    all.push(...parseRoadMetringPoints(json));
    const count = json.features?.length ?? 0;
    if (count < 2000) break;
    offset += count;
  }
  const unique = new Map(all.map(point => [`${point.road}:${point.km}:${point.direction ?? ""}:${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`, point]));
  return { points: [...unique.values()], updatedAt };
}

async function fetchRwsVildLayer(layer: number) {
  const params = new URLSearchParams({
    where: "roadnumber LIKE 'A%'", outFields: "*", returnGeometry: "true",
    geometry: `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`, geometryType: "esriGeometryEnvelope",
    inSR: "4326", spatialRel: "esriSpatialRelIntersects", outSR: "4326", resultRecordCount: "50000", f: "geojson",
  });
  const response = await fetch(`${URLS.rwsVild}/${layer}/query?${params}`, { next: { revalidate: 21600 }, headers: { "user-agent": "StandbyRadar/0.6" } });
  if (!response.ok) throw new Error(`RWS VILD ${layer} HTTP ${response.status}`);
  return { json: await response.json(), updatedAt: response.headers.get("last-modified") ?? response.headers.get("date") };
}

const anyScopeRange = (road: string, km: number, ranges: ImnRoadRange[]) => ranges.find(range => range.road === road && km >= range.fromKm && km <= range.toKm) ?? null;

function scopeCandidates(candidates: CandidateLocation[], ranges: ImnRoadRange[]) {
  return candidates.flatMap(candidate => {
    const exact = findImnRange(candidate.road, candidate.accessKm, candidate.direction, ranges);
    const range = exact ?? anyScopeRange(candidate.road, candidate.accessKm, ranges);
    return range ? [{ ...candidate, rayon: range.rayon }] : [];
  });
}

async function fetchOsmCandidates(points: RoadMetringPoint[], ranges: ImnRoadRange[]) {
  const query = `[out:json][timeout:8];(nwr["amenity"~"^(fuel|parking|restaurant|fast_food)$"](${BBOX.minLat},${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng});nwr["park_ride"="yes"](${BBOX.minLat},${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng});nwr["carpool"="yes"](${BBOX.minLat},${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng}););out center tags;`;
  const response = await fetch(URLS.overpass, {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(9000),
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": "StandbyRadar/0.6" },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
  return { locations: scopeCandidates(parseOsmCandidates(await response.json(), points), ranges), updatedAt: response.headers.get("date") ?? new Date().toISOString() };
}

function buildRoadOverlays(ranges: ImnRoadRange[], points: RoadMetringPoint[]): RayonRoadOverlay[] {
  const overlays: RayonRoadOverlay[] = [];
  for (const range of ranges) {
    const matching = points.filter(point => {
      if (point.road !== range.road || point.km < range.fromKm || point.km > range.toKm) return false;
      const direction = normalizeDirection(point.direction);
      return !range.direction || !direction || direction === range.direction;
    }).sort((a, b) => a.km - b.km);
    if (matching.length < 2) continue;
    const coordinates: Array<[number, number]> = [];
    for (let index = 0; index < matching.length; index += 3) coordinates.push([matching[index].lat, matching[index].lng]);
    const last = matching[matching.length - 1];
    if (!coordinates.length || coordinates[coordinates.length - 1][0] !== last.lat || coordinates[coordinates.length - 1][1] !== last.lng) coordinates.push([last.lat, last.lng]);
    overlays.push({ id: `${range.rayon}-${range.road}-${range.direction ?? "B"}-${range.fromKm}-${range.toKm}`, rayon: range.rayon, road: range.road, direction: range.direction, fromKm: range.fromKm, toKm: range.toKm, coordinates });
  }
  return overlays;
}

async function getStaticContext(): Promise<StaticContext> {
  if (staticCache && staticCache.expires > Date.now()) return staticCache;
  try {
    const [siteFeed, metering, contractFeed, rayonFeed] = await Promise.all([
      fetchRawSitesStreaming(), fetchRoadPoints(), fetchText(URLS.imnContracts, 21600), fetchText(URLS.imnRayons, 21600),
    ]);
    const rayonCodes = parseVanEijckRayonCodes(contractFeed.text);
    const ranges = parseImnRoadRanges(rayonFeed.text, rayonCodes);
    if (!ranges.length) throw new Error("IMN leverde geen Van Eijck IM-wegvakken");

    const scopedRoadPoints = metering.points.filter(point => Boolean(findImnRange(point.road, point.km, point.direction, ranges) ?? anyScopeRange(point.road, point.km, ranges)));
    const mapped = mapMeasurementSites(siteFeed.raw, metering.points);
    const sites: ScopedMeasurementSite[] = mapped.flatMap(site => {
      const range = findImnRange(site.road, site.km, site.direction, ranges) ?? anyScopeRange(site.road, site.km, ranges);
      return range ? [{ ...site, rayon: range.rayon, rangeFromKm: range.fromKm, rangeToKm: range.toKm }] : [];
    });

    let rwsCandidates: CandidateLocation[] = [], osmCandidates: CandidateLocation[] = [];
    let rwsUpdatedAt: string | null = null, osmUpdatedAt: string | null = null, rwsError: string | null = null, osmError: string | null = null;
    try {
      const [rest, service, fuel] = await Promise.all([fetchRwsVildLayer(18), fetchRwsVildLayer(19), fetchRwsVildLayer(23)]);
      const parsed = [
        ...parseRwsVildCandidates(rest.json, metering.points, "parking", "parkeerplaats"),
        ...parseRwsVildCandidates(service.json, metering.points, "service_area", "serviceplaats"),
        ...parseRwsVildCandidates(fuel.json, metering.points, "fuel", "tankstation"),
      ];
      rwsCandidates = scopeCandidates(parsed, ranges);
      rwsUpdatedAt = rest.updatedAt ?? service.updatedAt ?? fuel.updatedAt;
    } catch (error) { rwsError = error instanceof Error ? error.message : "Niet bereikbaar"; }

    try {
      const result = await fetchOsmCandidates(metering.points, ranges);
      osmCandidates = result.locations;
      osmUpdatedAt = result.updatedAt;
    } catch (error) { osmError = error instanceof Error ? error.message : "Niet bereikbaar"; }

    const deduped = new Map<string, CandidateLocation>();
    for (const location of [...rwsCandidates, ...osmCandidates]) {
      const key = `${location.rayon}:${location.road}:${Math.round(location.accessKm * 2) / 2}:${location.name.toLowerCase()}`;
      const previous = deduped.get(key);
      if (!previous || (location.source === "rws" && previous.source !== "rws")) deduped.set(key, location);
    }
    const all = [...deduped.values()];
    rwsCandidates = all.filter(location => location.source === "rws");
    osmCandidates = all.filter(location => location.source === "osm");

    staticCache = {
      expires: Date.now() + STATIC_TTL, sites, roadPoints: metering.points, scopedRoadPoints, rayonCodes, ranges,
      roadOverlays: buildRoadOverlays(ranges, metering.points), rwsCandidates, osmCandidates,
      siteUpdatedAt: siteFeed.updatedAt, meteringUpdatedAt: metering.updatedAt,
      imnUpdatedAt: rayonFeed.updatedAt ?? contractFeed.updatedAt, rwsUpdatedAt, osmUpdatedAt, rwsError, osmError,
    };
    return staticCache;
  } catch (error) {
    if (staticCache) { staticCache.expires = Date.now() + 10 * 60 * 1000; return staticCache; }
    throw error;
  }
}

function assignEventToScope(event: TrafficEvent, points: RoadMetringPoint[], ranges: ImnRoadRange[]) {
  let nearest: { point: RoadMetringPoint; distance: number } | null = null;
  for (const point of points) {
    if (event.roadRef && point.road !== event.roadRef) continue;
    const distance = haversineKm(event, point);
    if (distance > 1.4) continue;
    if (!nearest || distance < nearest.distance) nearest = { point, distance };
  }
  if (!nearest) return null;
  const range = findImnRange(nearest.point.road, nearest.point.km, nearest.point.direction, ranges) ?? anyScopeRange(nearest.point.road, nearest.point.km, ranges);
  return range ? { ...event, roadRef: event.roadRef ?? nearest.point.road, rayon: range.rayon } : null;
}

const rushHour = () => {
  const hour = Number(new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", hour12: false }).format(new Date()));
  return (hour >= 6 && hour < 10) || (hour >= 15 && hour < 19);
};

async function weatherMap(points: Array<{ id: string; lat: number; lng: number }>) {
  const map = new Map<string, WeatherSnapshot>();
  for (let offset = 0; offset < points.length; offset += 40) {
    const chunk = points.slice(offset, offset + 40);
    const params = new URLSearchParams({ latitude: chunk.map(x => x.lat).join(","), longitude: chunk.map(x => x.lng).join(","), current: "precipitation,wind_gusts_10m,visibility,weather_code", timezone: "Europe/Amsterdam" });
    const response = await fetch(`${URLS.weather}?${params}`, { next: { revalidate: 300 } });
    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
    const raw = await response.json() as unknown, items = Array.isArray(raw) ? raw : [raw];
    chunk.forEach((point, index) => {
      const current = (items[index] as { current?: Record<string, unknown> } | undefined)?.current ?? {};
      map.set(point.id, { precipitation: Number(current.precipitation ?? 0), windGusts: Number(current.wind_gusts_10m ?? 0), visibility: Number(current.visibility ?? 0), weatherCode: current.weather_code === undefined ? null : Number(current.weather_code), observedAt: typeof current.time === "string" ? current.time : null });
    });
  }
  return map;
}

const segmentId = (seg: Segment) => `${seg.rayon}-${seg.road}-${seg.kmFrom}-${seg.kmTo}`;

export async function GET() {
  const generatedAt = new Date().toISOString();
  let staticContext: StaticContext | null = null, staticError: string | null = null;
  try { staticContext = await getStaticContext(); } catch (error) { staticError = error instanceof Error ? error.message : "Statische bronfout"; }

  const sites = staticContext?.sites ?? [], ranges = staticContext?.ranges ?? [], scopedRoadPoints = staticContext?.scopedRoadPoints ?? [];
  const candidates = [...(staticContext?.rwsCandidates ?? []), ...(staticContext?.osmCandidates ?? [])];
  const sources: SourceStatus[] = [
    { id: "imn-scope", name: "IMN Van Eijck-rayons", ok: ranges.length > 0, updatedAt: staticContext?.imnUpdatedAt ?? null, error: ranges.length ? null : staticError ?? "Geen IMN scope", lineage: "Stichting IMN contract + rayonindeling" },
    { id: "ndw-sites", name: "NDW fysieke meetlocaties", ok: sites.length > 0, updatedAt: staticContext?.siteUpdatedAt ?? null, error: sites.length ? null : "Geen meetpunten binnen Van Eijck IM-rayons", lineage: "NDW AVG meetlocaties" },
    { id: "rws-metering", name: "RWS A-wegmetrering", ok: scopedRoadPoints.length > 0, updatedAt: staticContext?.meteringUpdatedAt ?? null, error: scopedRoadPoints.length ? null : "Geen RWS metrering binnen scope", lineage: "Rijkswaterstaat NWB metrering" },
    { id: "ndw-flow", name: "NDW snelheid + intensiteit", ok: false, updatedAt: null, error: null, lineage: "NDW/RWS fysieke detectoren" },
    { id: "rws-matrix", name: "RWS matrixsignalen", ok: false, updatedAt: null, error: null, lineage: "RWS wegkantsystemen via NDW" },
    { id: "ndw-current", name: "NDW Actueel Beeld", ok: false, updatedAt: null, error: null, lineage: "NDW situatiepublicatie" },
    { id: "rws-locations", name: "RWS stand-bylocaties", ok: (staticContext?.rwsCandidates.length ?? 0) > 0, updatedAt: staticContext?.rwsUpdatedAt ?? null, error: staticContext?.rwsError ?? ((staticContext?.rwsCandidates.length ?? 0) ? null : "Geen RWS locaties binnen scope"), lineage: "Rijkswaterstaat VILD" },
    { id: "osm-locations", name: "OSM extra locaties", ok: (staticContext?.osmCandidates.length ?? 0) > 0, updatedAt: staticContext?.osmUpdatedAt ?? null, error: staticContext?.osmError ?? ((staticContext?.osmCandidates.length ?? 0) ? null : "Optionele OSM bron niet beschikbaar"), lineage: "OpenStreetMap via Overpass" },
    { id: "weather", name: "Open-Meteo weer", ok: false, updatedAt: null, error: null, lineage: "Open-Meteo" },
  ];

  let events: TrafficEvent[] = [], matrix = parseMatrix(""), samples: SiteTraffic[] = [];
  const siteMap = new Map<string, MeasurementSite>(sites.map(site => [site.id, site]));
  await Promise.all([
    fetchTrafficStreaming(siteMap).then(result => { samples = result.samples; sources[3] = { ...sources[3], ok: samples.length > 0, updatedAt: result.updatedAt, error: samples.length ? null : "Geen verse detectorwaarden binnen scope" }; }).catch(error => { sources[3].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
    fetchText(URLS.matrix, 20).then(result => {
      matrix = parseMatrix(result.text).filter(signal => signal.road && signal.km !== null && Boolean(anyScopeRange(signal.road, signal.km, ranges)));
      sources[4] = { ...sources[4], ok: true, updatedAt: result.updatedAt };
    }).catch(error => { sources[4].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
    fetchText(URLS.current, 20).then(result => {
      events = parseEvents(result.text).map(event => assignEventToScope(event, scopedRoadPoints, ranges)).filter((event): event is TrafficEvent => Boolean(event));
      sources[5] = { ...sources[5], ok: true, updatedAt: result.updatedAt ?? (stripTags(tagValue(result.text, "publicationTime") ?? "") || null) };
    }).catch(error => { sources[5].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
  ]);

  const segments = buildSegments(sites);
  let weather = new Map<string, WeatherSnapshot>();
  try {
    weather = await weatherMap(segments.map(seg => ({ id: segmentId(seg), lat: seg.lat, lng: seg.lng })));
    sources[8] = { ...sources[8], ok: weather.size > 0, updatedAt: [...weather.values()][0]?.observedAt ?? generatedAt };
  } catch (error) { sources[8].error = error instanceof Error ? error.message : "Niet bereikbaar"; }

  const sampleMap = new Map(samples.map(sample => [sample.siteId, sample]));
  const scored = segments.map(seg => {
    const sensor = sensorMetrics(seg, sampleMap), msi = segmentMatrix(matrix, seg), incident = segmentEvents(seg, events), localWeather = weather.get(segmentId(seg)) ?? null, weatherPoints = weatherScore(localWeather);
    const corroboratingSignals = [sensor.sensorCount > 0 && sensor.congestionIndex >= 25, msi.clusters > 0, incident.items.length > 0, weatherPoints >= 2].filter(Boolean).length;
    let score = Math.round(sensor.score + msi.score + incident.score + weatherPoints + (corroboratingSignals >= 2 ? 4 : 0));
    if (!sensor.sensorCount) score = Math.min(score, 48);
    if (corroboratingSignals <= 1) score = Math.min(score, 52);
    score = Math.max(0, Math.min(96, score));
    const highCoverage = sensor.sensorCount >= 2 && sensor.directionCount >= 2;
    const confidence: StandbyAdvice["confidence"] = highCoverage && corroboratingSignals >= 2 && sources[3].ok && sources[4].ok ? "hoog" : sensor.sensorCount >= 1 && corroboratingSignals >= 1 ? "middel" : "laag";
    return { seg, sensor, msi, incident, localWeather, corroboratingSignals, score, confidence };
  }).sort((a, b) => b.score - a.score || b.corroboratingSignals - a.corroboratingSignals);

  const advice: StandbyAdvice[] = [], chosenLocations: CandidateLocation[] = [];
  for (const item of scored) {
    const match = chooseDynamicStandby(item.seg, candidates, chosenLocations);
    if (!match) continue;
    chosenLocations.push(match.location);
    const pressure: StandbyAdvice["pressure"] = item.score >= 65 ? "hoog" : item.score >= 38 ? "verhoogd" : "rustig";
    const maxSnap = item.seg.sites.length ? Math.max(...item.seg.sites.map(site => site.mappingDistanceMeters)) : 0;
    const locationType = match.location.source === "rws" ? `officiële RWS-${match.location.kind}` : `${match.location.kind}-locatie uit OpenStreetMap`;
    const reasons = [
      `${item.seg.rayon} · ${item.seg.road} km ${item.seg.kmFrom}–${item.seg.kmTo}: uitsluitend binnen het officiële Van Eijck IM-rayon`,
      item.sensor.sensorCount ? `${item.sensor.sensorCount} verse fysieke detector(en), ${item.sensor.directionCount} rijrichtinggroep(en): ${item.sensor.averageSpeedKph ?? "—"} km/u mediaan${item.sensor.flowVehiclesPerHour !== null ? `, ${item.sensor.flowVehiclesPerHour} vtg/u mediaan` : ""}` : "geen verse fysieke snelheid/intensiteit — hoge score automatisch geblokkeerd",
      `meetpunten zijn aan officiële RWS A-wegmetrering gekoppeld (max. snapafstand ${maxSnap} m)`,
      item.msi.clusters ? `${item.msi.clusters} matrixcluster(s) uitsluitend binnen dit wegdeel` : "geen actieve matrixmaatregelen binnen dit wegdeel",
      item.incident.accidents ? `${item.incident.accidents} actueel ongeval(len) binnen/naast dit IM-rayon` : null,
      item.incident.obstructions ? `${item.incident.obstructions} actuele blokkade(s)/obstakels binnen/naast dit IM-rayon` : null,
      item.corroboratingSignals >= 2 ? `${item.corroboratingSignals} verschillende actuele signalen bevestigen de druk` : "onvoldoende bronbevestiging voor hoge zekerheid",
      `stand-byplek automatisch gekozen ná de live score: ${locationType}, circa ${match.roadDistance.toFixed(1)} km langs dezelfde A-weg`,
    ].filter((x): x is string => Boolean(x));
    advice.push({
      id: segmentId(item.seg), rayon: item.seg.rayon, road: item.seg.road, segmentName: `${item.seg.rayon} · ${item.seg.road} km ${item.seg.kmFrom}–${item.seg.kmTo}`,
      kmFrom: item.seg.kmFrom, kmTo: item.seg.kmTo, score: item.score, pressure, confidence: item.confidence,
      recommendedUnits: item.score >= 72 && item.confidence !== "laag" ? 2 : item.score >= 38 ? 1 : 0,
      sensorCount: item.sensor.sensorCount, averageSpeedKph: item.sensor.averageSpeedKph, flowVehiclesPerHour: item.sensor.flowVehiclesPerHour, congestionIndex: item.sensor.congestionIndex,
      localEvents: item.incident.items.length, accidents: item.incident.accidents, obstructions: item.incident.obstructions, matrixClusters: item.msi.clusters, lowSpeedMatrixClusters: item.msi.lowSpeed,
      corroboratingSignals: item.corroboratingSignals, reasons, weather: item.localWeather,
      standby: { id: match.location.id, name: match.location.name, address: match.location.address, lat: match.location.lat, lng: match.location.lng, kind: match.location.kind, source: match.location.source, verified: match.location.verified },
    });
    if (advice.length >= 30) break;
  }

  const byRoad = matrixSummary(matrix), activeSignals = byRoad.reduce((sum, row) => sum + row.active, 0);
  return NextResponse.json({
    generatedAt, refreshAfterSeconds: 30, region: "Van Eijck IM-rayons", events, advice, sources,
    rayons: { codes: staticContext?.rayonCodes ?? [], roadOverlays: staticContext?.roadOverlays ?? [] },
    matrix: { activeSignals, byRoad },
    meta: {
      eventCount: events.length, accidentCount: events.filter(x => x.kind === "accident").length, obstructionCount: events.filter(x => x.kind === "obstruction").length,
      trafficCount: events.filter(x => x.kind === "traffic").length, closureCount: events.filter(x => x.kind === "closure").length,
      segmentCount: segments.length, measuredSiteCount: samples.length, candidateLocationCount: candidates.length, rayonCount: staticContext?.rayonCodes.length ?? 0,
      rushHour: rushHour(), modelVersion: "0.6-imn-eijck-scope-rws-vild",
      note: `Alleen data binnen de ${staticContext?.rayonCodes.length ?? 0} actuele Van Eijck/Van Eijck-Van Egeraat IM-rayons van Stichting IMN wordt verwerkt. IM-wegvakken zijn op wegnummer, rijrichting en hectometer begrensd. Primaire stand-byplekken komen uit Rijkswaterstaat VILD; OSM is alleen aanvullend.`,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}