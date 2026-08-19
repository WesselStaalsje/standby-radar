import { createGunzip, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import type { RayonRoadOverlay, SourceStatus, StandbyAdvice, TrafficEvent, WeatherSnapshot } from "@/lib/types";
import type { MeasurementSite, RoadMetringPoint, SiteTraffic } from "@/lib/ndw";
import { matrixSummary, parseEvents, parseMatrix, parseRoadMetringPoints, parseTrafficSamples, stripTags, tagValue } from "@/lib/ndw";
import { buildSegments, chooseDynamicStandby, haversineKm, parseOsmCandidates, parseRwsVildCandidates, segmentEvents, segmentMatrix, sensorMetrics, weatherScore, type CandidateLocation, type ScopedMeasurementSite, type Segment } from "@/lib/engine";
import { findImnRange, normalizeDirection, parseImnRoadRanges, parseVanEijckRayonCodes, type ImnRoadRange } from "@/lib/rayons";
import { loadImnSiteSnapshot } from "@/lib/imn-site-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const URLS = {
  current: "https://opendata.ndw.nu/actueel_beeld.xml.gz",
  matrix: "https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz",
  traffic: "https://opendata.ndw.nu/trafficspeed.xml.gz",
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
  scopedRoadPoints: RoadMetringPoint[];
  rayonCodes: string[];
  ranges: ImnRoadRange[];
  roadOverlays: RayonRoadOverlay[];
  rwsCandidates: CandidateLocation[];
  osmCandidates: CandidateLocation[];
  snapshotGeneratedAt: string;
  meteringUpdatedAt: string | null;
  imnUpdatedAt: string | null;
  rwsUpdatedAt: string | null;
  osmUpdatedAt: string | null;
  rwsError: string | null;
  osmError: string | null;
};

let staticCache: StaticContext | null = null;

const fetchText = async (url: string, revalidate: number) => {
  const response = await fetch(url, {
    next: { revalidate },
    headers: { "user-agent": "StandbyRadar/0.7" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer[0] === 31 && buffer[1] === 139
    ? gunzipSync(buffer).toString("utf8")
    : buffer.toString("utf8");
  return {
    text,
    updatedAt: response.headers.get("last-modified") ?? response.headers.get("date"),
  };
};

async function streamGzipRecords(
  url: string,
  recordName: string,
  onRecord: (record: string) => void,
  timeoutMs: number,
) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "StandbyRadar/0.7" },
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

  const stream = Readable.fromWeb(response.body as never).pipe(createGunzip());
  const decoder = new TextDecoder();
  const startRegex = new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${recordName}\\b`, "i");
  const endRegex = new RegExp(`</(?:(?:[A-Za-z0-9_-]+):)?${recordName}>`, "i");
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    while (true) {
      const startMatch = startRegex.exec(buffer);
      if (!startMatch) {
        if (buffer.length > 4096) buffer = buffer.slice(-4096);
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

async function fetchTraffic(siteMap: Map<string, MeasurementSite>) {
  const collected = new Map<string, SiteTraffic>();
  let updatedAt: string | null = null;
  let partialError: string | null = null;

  try {
    updatedAt = await streamGzipRecords(URLS.traffic, "siteMeasurements", record => {
      for (const sample of parseTrafficSamples(record, siteMap)) collected.set(sample.siteId, sample);
    }, 18_000);
  } catch (error) {
    partialError = error instanceof Error ? error.message : "NDW minuutfeed onderbroken";
    if (!collected.size) throw error;
  }

  return { samples: [...collected.values()], updatedAt, partialError };
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
      headers: { "user-agent": "StandbyRadar/0.7" },
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

async function fetchVild(layer: number) {
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
  const response = await fetch(`${URLS.rwsVild}/${layer}/query?${params}`, {
    next: { revalidate: 21600 },
    signal: AbortSignal.timeout(12_000),
    headers: { "user-agent": "StandbyRadar/0.7" },
  });
  if (!response.ok) throw new Error(`RWS VILD ${layer} HTTP ${response.status}`);
  return {
    json: await response.json(),
    updatedAt: response.headers.get("last-modified") ?? response.headers.get("date"),
  };
}

const anyRange = (road: string, km: number, ranges: ImnRoadRange[]) =>
  ranges.find(range => range.road === road && km >= range.fromKm && km <= range.toKm) ?? null;

const scopeCandidates = (items: CandidateLocation[], ranges: ImnRoadRange[]) =>
  items.flatMap(item => {
    const range = findImnRange(item.road, item.accessKm, item.direction, ranges) ?? anyRange(item.road, item.accessKm, ranges);
    return range ? [{ ...item, rayon: range.rayon }] : [];
  });

async function fetchOsm(points: RoadMetringPoint[], ranges: ImnRoadRange[]) {
  const query = `[out:json][timeout:6];(nwr["amenity"~"^(fuel|parking|restaurant|fast_food)$"](${BBOX.minLat},${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng});nwr["park_ride"="yes"](${BBOX.minLat},${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng});nwr["carpool"="yes"](${BBOX.minLat},${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng}););out center tags;`;
  const response = await fetch(URLS.overpass, {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(7_000),
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "StandbyRadar/0.7",
    },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
  return {
    locations: scopeCandidates(parseOsmCandidates(await response.json(), points), ranges),
    updatedAt: response.headers.get("date") ?? new Date().toISOString(),
  };
}

function buildRoadOverlays(ranges: ImnRoadRange[], points: RoadMetringPoint[]): RayonRoadOverlay[] {
  const out: RayonRoadOverlay[] = [];
  for (const range of ranges) {
    const matching = points
      .filter(point => {
        if (point.road !== range.road || point.km < range.fromKm || point.km > range.toKm) return false;
        const direction = normalizeDirection(point.direction);
        return !range.direction || !direction || direction === range.direction;
      })
      .sort((a, b) => a.km - b.km);
    if (matching.length < 2) continue;

    const coordinates: Array<[number, number]> = [];
    for (let index = 0; index < matching.length; index += 3) {
      coordinates.push([matching[index].lat, matching[index].lng]);
    }
    const last = matching[matching.length - 1];
    const final = coordinates[coordinates.length - 1];
    if (!final || final[0] !== last.lat || final[1] !== last.lng) coordinates.push([last.lat, last.lng]);

    out.push({
      id: `${range.rayon}-${range.road}-${range.direction ?? "B"}-${range.fromKm}-${range.toKm}`,
      rayon: range.rayon,
      road: range.road,
      direction: range.direction,
      fromKm: range.fromKm,
      toKm: range.toKm,
      coordinates,
    });
  }
  return out;
}

async function getStaticContext(): Promise<StaticContext> {
  if (staticCache && staticCache.expires > Date.now()) return staticCache;

  try {
    const snapshot = loadImnSiteSnapshot();
    const [metering, contractFeed, rayonFeed] = await Promise.all([
      fetchRoadPoints(),
      fetchText(URLS.imnContracts, 21600),
      fetchText(URLS.imnRayons, 21600),
    ]);

    const rayonCodes = parseVanEijckRayonCodes(contractFeed.text);
    const ranges = parseImnRoadRanges(rayonFeed.text, rayonCodes);
    if (!ranges.length) throw new Error("IMN leverde geen Van Eijck IM-wegvakken");

    const scopedRoadPoints = metering.points.filter(point =>
      Boolean(findImnRange(point.road, point.km, point.direction, ranges) ?? anyRange(point.road, point.km, ranges))
    );

    const sites: ScopedMeasurementSite[] = snapshot.sites.flatMap(site => {
      const range = findImnRange(site.road, site.km, site.direction, ranges) ?? anyRange(site.road, site.km, ranges);
      return range ? [{ ...site, rayon: range.rayon, rangeFromKm: range.fromKm, rangeToKm: range.toKm }] : [];
    });

    let rwsCandidates: CandidateLocation[] = [];
    let osmCandidates: CandidateLocation[] = [];
    let rwsUpdatedAt: string | null = null;
    let osmUpdatedAt: string | null = null;
    let rwsError: string | null = null;
    let osmError: string | null = null;

    const [rwsResult, osmResult] = await Promise.allSettled([
      Promise.all([fetchVild(18), fetchVild(19), fetchVild(23)]),
      fetchOsm(metering.points, ranges),
    ]);

    if (rwsResult.status === "fulfilled") {
      const [rest, service, fuel] = rwsResult.value;
      rwsCandidates = scopeCandidates([
        ...parseRwsVildCandidates(rest.json, metering.points, "parking", "parkeerplaats"),
        ...parseRwsVildCandidates(service.json, metering.points, "service_area", "serviceplaats"),
        ...parseRwsVildCandidates(fuel.json, metering.points, "fuel", "tankstation"),
      ], ranges);
      rwsUpdatedAt = rest.updatedAt ?? service.updatedAt ?? fuel.updatedAt;
    } else {
      rwsError = rwsResult.reason instanceof Error ? rwsResult.reason.message : "Niet bereikbaar";
    }

    if (osmResult.status === "fulfilled") {
      osmCandidates = osmResult.value.locations;
      osmUpdatedAt = osmResult.value.updatedAt;
    } else {
      osmError = osmResult.reason instanceof Error ? osmResult.reason.message : "Niet bereikbaar";
    }

    const deduped = new Map<string, CandidateLocation>();
    for (const location of [...rwsCandidates, ...osmCandidates]) {
      const key = `${location.rayon}:${location.road}:${Math.round(location.accessKm * 2) / 2}:${location.name.toLowerCase()}`;
      const previous = deduped.get(key);
      if (!previous || (location.source === "rws" && previous.source !== "rws")) deduped.set(key, location);
    }
    const allCandidates = [...deduped.values()];

    staticCache = {
      expires: Date.now() + STATIC_TTL,
      sites,
      scopedRoadPoints,
      rayonCodes,
      ranges,
      roadOverlays: buildRoadOverlays(ranges, metering.points),
      rwsCandidates: allCandidates.filter(location => location.source === "rws"),
      osmCandidates: allCandidates.filter(location => location.source === "osm"),
      snapshotGeneratedAt: snapshot.generatedAt,
      meteringUpdatedAt: metering.updatedAt,
      imnUpdatedAt: rayonFeed.updatedAt ?? contractFeed.updatedAt,
      rwsUpdatedAt,
      osmUpdatedAt,
      rwsError,
      osmError,
    };
    return staticCache;
  } catch (error) {
    if (staticCache) {
      staticCache.expires = Date.now() + 10 * 60 * 1000;
      return staticCache;
    }
    throw error;
  }
}

function assignEventToScope(event: TrafficEvent, points: RoadMetringPoint[], ranges: ImnRoadRange[]): TrafficEvent | null {
  let nearest: { point: RoadMetringPoint; distance: number } | null = null;
  for (const point of points) {
    if (event.roadRef && point.road !== event.roadRef) continue;
    const distance = haversineKm(event, point);
    if (distance > 1.4) continue;
    if (!nearest || distance < nearest.distance) nearest = { point, distance };
  }
  if (!nearest) return null;
  const range = findImnRange(nearest.point.road, nearest.point.km, nearest.point.direction, ranges)
    ?? anyRange(nearest.point.road, nearest.point.km, ranges);
  return range ? { ...event, roadRef: event.roadRef ?? nearest.point.road, rayon: range.rayon } : null;
}

const rushHour = () => {
  const hour = Number(new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    hour12: false,
  }).format(new Date()));
  return (hour >= 6 && hour < 10) || (hour >= 15 && hour < 19);
};

async function weatherMap(points: Array<{ id: string; lat: number; lng: number }>) {
  const map = new Map<string, WeatherSnapshot>();
  for (let offset = 0; offset < points.length; offset += 40) {
    const chunk = points.slice(offset, offset + 40);
    const params = new URLSearchParams({
      latitude: chunk.map(point => point.lat).join(","),
      longitude: chunk.map(point => point.lng).join(","),
      current: "precipitation,wind_gusts_10m,visibility,weather_code",
      timezone: "Europe/Amsterdam",
    });
    const response = await fetch(`${URLS.weather}?${params}`, { next: { revalidate: 300 } });
    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
    const raw = await response.json() as unknown;
    const items = Array.isArray(raw) ? raw : [raw];
    chunk.forEach((point, index) => {
      const current = (items[index] as { current?: Record<string, unknown> } | undefined)?.current ?? {};
      map.set(point.id, {
        precipitation: Number(current.precipitation ?? 0),
        windGusts: Number(current.wind_gusts_10m ?? 0),
        visibility: Number(current.visibility ?? 0),
        weatherCode: current.weather_code === undefined ? null : Number(current.weather_code),
        observedAt: typeof current.time === "string" ? current.time : null,
      });
    });
  }
  return map;
}

const segmentId = (segment: Segment) => `${segment.rayon}-${segment.road}-${segment.kmFrom}-${segment.kmTo}`;

export async function GET() {
  const generatedAt = new Date().toISOString();
  let context: StaticContext | null = null;
  let staticError: string | null = null;
  try {
    context = await getStaticContext();
  } catch (error) {
    staticError = error instanceof Error ? error.message : "Statische bronfout";
  }

  const sites = context?.sites ?? [];
  const ranges = context?.ranges ?? [];
  const scopedRoadPoints = context?.scopedRoadPoints ?? [];
  const candidates = [...(context?.rwsCandidates ?? []), ...(context?.osmCandidates ?? [])];

  const sources: SourceStatus[] = [
    { id: "imn-scope", name: "IMN Van Eijck-rayons", ok: ranges.length > 0, updatedAt: context?.imnUpdatedAt ?? null, error: ranges.length ? null : staticError ?? "Geen IMN scope", lineage: "Stichting IMN contract + rayonindeling" },
    { id: "ndw-sites", name: "NDW meetlocatieconfig", ok: sites.length > 0, updatedAt: context?.snapshotGeneratedAt ?? null, error: sites.length ? null : "Geen meetpunten binnen Van Eijck IM-rayons", lineage: "Compacte NDW meetpuntsnapshot; live waarden apart" },
    { id: "rws-metering", name: "RWS A-wegmetrering", ok: scopedRoadPoints.length > 0, updatedAt: context?.meteringUpdatedAt ?? null, error: scopedRoadPoints.length ? null : "Geen RWS metrering binnen scope", lineage: "Rijkswaterstaat NWB metrering" },
    { id: "ndw-flow", name: "NDW snelheid + intensiteit", ok: false, updatedAt: null, error: null, lineage: "NDW/RWS fysieke detectoren" },
    { id: "rws-matrix", name: "RWS matrixsignalen", ok: false, updatedAt: null, error: null, lineage: "RWS wegkantsystemen via NDW" },
    { id: "ndw-current", name: "NDW Actueel Beeld", ok: false, updatedAt: null, error: null, lineage: "NDW situatiepublicatie" },
    { id: "rws-locations", name: "RWS stand-bylocaties", ok: (context?.rwsCandidates.length ?? 0) > 0, updatedAt: context?.rwsUpdatedAt ?? null, error: context?.rwsError ?? ((context?.rwsCandidates.length ?? 0) ? null : "Geen RWS locaties binnen scope"), lineage: "Rijkswaterstaat VILD" },
    { id: "osm-locations", name: "OSM extra locaties", ok: (context?.osmCandidates.length ?? 0) > 0, updatedAt: context?.osmUpdatedAt ?? null, error: context?.osmError ?? ((context?.osmCandidates.length ?? 0) ? null : "Optionele OSM bron niet beschikbaar"), lineage: "OpenStreetMap via Overpass" },
    { id: "weather", name: "Open-Meteo weer", ok: false, updatedAt: null, error: null, lineage: "Open-Meteo" },
  ];

  let events: TrafficEvent[] = [];
  let matrix = parseMatrix("");
  let samples: SiteTraffic[] = [];
  const siteMap = new Map<string, MeasurementSite>(sites.map(site => [site.id, site]));

  await Promise.all([
    fetchTraffic(siteMap)
      .then(result => {
        samples = result.samples;
        sources[3] = {
          ...sources[3],
          ok: samples.length > 0,
          updatedAt: result.updatedAt ?? generatedAt,
          error: result.partialError ? `Gedeeltelijke minuutfeed: ${result.partialError}` : samples.length ? null : "Geen verse detectorwaarden binnen scope",
        };
      })
      .catch(error => { sources[3].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
    fetchText(URLS.matrix, 20)
      .then(result => {
        matrix = parseMatrix(result.text).filter(signal => signal.road && signal.km !== null && Boolean(anyRange(signal.road, signal.km, ranges)));
        sources[4] = { ...sources[4], ok: true, updatedAt: result.updatedAt };
      })
      .catch(error => { sources[4].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
    fetchText(URLS.current, 20)
      .then(result => {
        events = parseEvents(result.text).flatMap(event => {
          const scoped = assignEventToScope(event, scopedRoadPoints, ranges);
          return scoped ? [scoped] : [];
        });
        sources[5] = { ...sources[5], ok: true, updatedAt: result.updatedAt ?? (stripTags(tagValue(result.text, "publicationTime") ?? "") || null) };
      })
      .catch(error => { sources[5].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
  ]);

  const segments = buildSegments(sites);
  let weather = new Map<string, WeatherSnapshot>();
  try {
    weather = await weatherMap(segments.map(segment => ({ id: segmentId(segment), lat: segment.lat, lng: segment.lng })));
    sources[8] = { ...sources[8], ok: weather.size > 0, updatedAt: [...weather.values()][0]?.observedAt ?? generatedAt };
  } catch (error) {
    sources[8].error = error instanceof Error ? error.message : "Niet bereikbaar";
  }

  const sampleMap = new Map(samples.map(sample => [sample.siteId, sample]));
  const scored = segments.map(segment => {
    const sensor = sensorMetrics(segment, sampleMap);
    const msi = segmentMatrix(matrix, segment);
    const incident = segmentEvents(segment, events);
    const localWeather = weather.get(segmentId(segment)) ?? null;
    const weatherPoints = weatherScore(localWeather);
    const corroboratingSignals = [
      sensor.sensorCount > 0 && sensor.congestionIndex >= 25,
      msi.clusters > 0,
      incident.items.length > 0,
      weatherPoints >= 2,
    ].filter(Boolean).length;

    let score = Math.round(sensor.score + msi.score + incident.score + weatherPoints + (corroboratingSignals >= 2 ? 4 : 0));
    if (!sensor.sensorCount) score = Math.min(score, 48);
    if (corroboratingSignals <= 1) score = Math.min(score, 52);
    score = Math.max(0, Math.min(96, score));

    const highCoverage = sensor.sensorCount >= 2 && sensor.directionCount >= 2;
    const confidence: StandbyAdvice["confidence"] = highCoverage && corroboratingSignals >= 2 && sources[3].ok && sources[4].ok
      ? "hoog"
      : sensor.sensorCount >= 1 && corroboratingSignals >= 1 ? "middel" : "laag";

    return { segment, sensor, msi, incident, localWeather, corroboratingSignals, score, confidence };
  }).sort((a, b) => b.score - a.score || b.corroboratingSignals - a.corroboratingSignals);

  const advice: StandbyAdvice[] = [];
  const chosen: CandidateLocation[] = [];
  for (const item of scored) {
    const match = chooseDynamicStandby(item.segment, candidates, chosen);
    if (!match) continue;
    chosen.push(match.location);

    const pressure: StandbyAdvice["pressure"] = item.score >= 65 ? "hoog" : item.score >= 38 ? "verhoogd" : "rustig";
    const maxSnap = item.segment.sites.length ? Math.max(...item.segment.sites.map(site => site.mappingDistanceMeters)) : 0;
    const locationType = match.location.source === "rws"
      ? `officiële RWS-${match.location.kind}`
      : `${match.location.kind}-locatie uit OpenStreetMap`;

    const reasons = [
      `${item.segment.rayon} · ${item.segment.road} km ${item.segment.kmFrom}–${item.segment.kmTo}: uitsluitend binnen het officiële Van Eijck IM-rayon`,
      item.sensor.sensorCount
        ? `${item.sensor.sensorCount} verse fysieke detector(en), ${item.sensor.directionCount} rijrichtinggroep(en): ${item.sensor.averageSpeedKph ?? "—"} km/u mediaan${item.sensor.flowVehiclesPerHour !== null ? `, ${item.sensor.flowVehiclesPerHour} vtg/u mediaan` : ""}`
        : "geen verse fysieke snelheid/intensiteit — hoge score automatisch geblokkeerd",
      `meetpunten zijn aan officiële RWS A-wegmetrering gekoppeld (max. snapafstand ${maxSnap} m)`,
      item.msi.clusters ? `${item.msi.clusters} matrixcluster(s) uitsluitend binnen dit wegdeel` : "geen actieve matrixmaatregelen binnen dit wegdeel",
      item.incident.accidents ? `${item.incident.accidents} actueel ongeval(len) binnen/naast dit IM-rayon` : null,
      item.incident.obstructions ? `${item.incident.obstructions} actuele blokkade(s)/obstakels binnen/naast dit IM-rayon` : null,
      item.corroboratingSignals >= 2 ? `${item.corroboratingSignals} verschillende actuele signalen bevestigen de druk` : "onvoldoende bronbevestiging voor hoge zekerheid",
      `stand-byplek automatisch gekozen ná de live score: ${locationType}, circa ${match.roadDistance.toFixed(1)} km langs dezelfde A-weg`,
    ].filter((reason): reason is string => Boolean(reason));

    advice.push({
      id: segmentId(item.segment),
      rayon: item.segment.rayon,
      road: item.segment.road,
      segmentName: `${item.segment.rayon} · ${item.segment.road} km ${item.segment.kmFrom}–${item.segment.kmTo}`,
      kmFrom: item.segment.kmFrom,
      kmTo: item.segment.kmTo,
      score: item.score,
      pressure,
      confidence: item.confidence,
      recommendedUnits: item.score >= 72 && item.confidence !== "laag" ? 2 : item.score >= 38 ? 1 : 0,
      sensorCount: item.sensor.sensorCount,
      averageSpeedKph: item.sensor.averageSpeedKph,
      flowVehiclesPerHour: item.sensor.flowVehiclesPerHour,
      congestionIndex: item.sensor.congestionIndex,
      localEvents: item.incident.items.length,
      accidents: item.incident.accidents,
      obstructions: item.incident.obstructions,
      matrixClusters: item.msi.clusters,
      lowSpeedMatrixClusters: item.msi.lowSpeed,
      corroboratingSignals: item.corroboratingSignals,
      reasons,
      weather: item.localWeather,
      standby: {
        id: match.location.id,
        name: match.location.name,
        address: match.location.address,
        lat: match.location.lat,
        lng: match.location.lng,
        kind: match.location.kind,
        source: match.location.source,
        verified: match.location.verified,
      },
    });
    if (advice.length >= 30) break;
  }

  const byRoad = matrixSummary(matrix);
  const activeSignals = byRoad.reduce((sum, row) => sum + row.active, 0);

  return NextResponse.json({
    generatedAt,
    refreshAfterSeconds: 30,
    region: "Van Eijck IM-rayons",
    events,
    advice,
    sources,
    rayons: {
      codes: context?.rayonCodes ?? [],
      roadOverlays: context?.roadOverlays ?? [],
    },
    matrix: { activeSignals, byRoad },
    meta: {
      eventCount: events.length,
      accidentCount: events.filter(event => event.kind === "accident").length,
      obstructionCount: events.filter(event => event.kind === "obstruction").length,
      trafficCount: events.filter(event => event.kind === "traffic").length,
      closureCount: events.filter(event => event.kind === "closure").length,
      segmentCount: segments.length,
      measuredSiteCount: samples.length,
      candidateLocationCount: candidates.length,
      rayonCount: context?.rayonCodes.length ?? 0,
      rushHour: rushHour(),
      modelVersion: "0.7-imn-snapshot-rws-vild",
      note: `Alleen data binnen de ${context?.rayonCodes.length ?? 0} actuele Van Eijck/Van Eijck-Van Egeraat IM-rayons van Stichting IMN wordt verwerkt. IM-wegvakken zijn exact op wegnummer, rijrichting en hectometer begrensd. De zware NDW meetlocatieconfiguratie is vooraf gecomprimeerd; de verkeerswaarden blijven live. Primaire stand-byplekken komen uit Rijkswaterstaat VILD; OSM is alleen aanvullend.`,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
