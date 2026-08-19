import { createGunzip, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import type { SourceStatus, StandbyAdvice, WeatherSnapshot } from "@/lib/types";
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
  parseOsmCandidates,
  parseRwsRestAreas,
  segmentEvents,
  segmentMatrix,
  sensorMetrics,
  weatherScore,
  type CandidateLocation,
  type Segment,
} from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const URLS = {
  current: "https://opendata.ndw.nu/actueel_beeld.xml.gz",
  matrix: "https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz",
  traffic: "https://opendata.ndw.nu/trafficspeed.xml.gz",
  sites: "https://opendata.ndw.nu/measurement_current.xml.gz",
  rwsMetering: "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/nwb_metrering/MapServer/2/query",
  rwsAreas: "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/omgevingswet/FeatureServer/45/query",
  overpass: "https://overpass-api.de/api/interpreter",
  weather: "https://api.open-meteo.com/v1/forecast",
};

const STATIC_TTL = 6 * 60 * 60 * 1000;

type StaticContext = {
  expires: number;
  sites: MeasurementSite[];
  roadPoints: RoadMetringPoint[];
  rwsAreas: CandidateLocation[];
  osmCandidates: CandidateLocation[];
  siteUpdatedAt: string | null;
  meteringUpdatedAt: string | null;
  rwsAreasUpdatedAt: string | null;
  osmUpdatedAt: string | null;
  rwsAreasError: string | null;
  osmError: string | null;
};

let staticCache: StaticContext | null = null;

const fetchText = async (url: string, revalidate: number) => {
  const response = await fetch(url, {
    next: { revalidate },
    headers: { "user-agent": "StandbyRadar/0.5" },
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

async function streamGzipXmlRecords(
  url: string,
  recordName: string,
  onRecord: (record: string) => void,
) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "user-agent": "StandbyRadar/0.5" },
  });
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
  let offset = 0;
  let updatedAt: string | null = null;

  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      where: "a_n_nr LIKE 'A%'",
      outFields: "a_n_nr,l_r,hectometer,hectomtrng",
      returnGeometry: "true",
      geometry: "4.20,51.15,6.55,52.30",
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
      headers: { "user-agent": "StandbyRadar/0.5" },
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

async function fetchRwsAreas(points: RoadMetringPoint[]) {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    geometry: "4.20,51.15,6.55,52.30",
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outSR: "4326",
    resultRecordCount: "2000",
    f: "geojson",
  });
  const response = await fetch(`${URLS.rwsAreas}?${params}`, {
    next: { revalidate: 21600 },
    headers: { "user-agent": "StandbyRadar/0.5" },
  });
  if (!response.ok) throw new Error(`RWS locaties HTTP ${response.status}`);
  const json = await response.json();
  return {
    locations: parseRwsRestAreas(json, points),
    updatedAt: response.headers.get("last-modified") ?? response.headers.get("date"),
  };
}

async function fetchOsmCandidates(points: RoadMetringPoint[]) {
  const query = `[out:json][timeout:50];
(
  nwr["amenity"~"^(fuel|parking|restaurant|fast_food)$"](51.15,4.20,52.30,6.55);
  nwr["park_ride"="yes"](51.15,4.20,52.30,6.55);
  nwr["carpool"="yes"](51.15,4.20,52.30,6.55);
);
out center tags;`;
  const response = await fetch(URLS.overpass, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "StandbyRadar/0.5",
    },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
  const json = await response.json();
  return {
    locations: parseOsmCandidates(json, points),
    updatedAt: response.headers.get("date") ?? new Date().toISOString(),
  };
}

async function getStaticContext(): Promise<StaticContext> {
  if (staticCache && staticCache.expires > Date.now()) return staticCache;

  const [siteFeed, metering] = await Promise.all([
    fetchRawSitesStreaming(),
    fetchRoadPoints(),
  ]);
  const sites = mapMeasurementSites(siteFeed.raw, metering.points);

  let rwsAreas: CandidateLocation[] = [];
  let osmCandidates: CandidateLocation[] = [];
  let rwsAreasUpdatedAt: string | null = null;
  let osmUpdatedAt: string | null = null;
  let rwsAreasError: string | null = null;
  let osmError: string | null = null;

  try {
    const result = await fetchRwsAreas(metering.points);
    rwsAreas = result.locations;
    rwsAreasUpdatedAt = result.updatedAt;
  } catch (error) {
    rwsAreasError = error instanceof Error ? error.message : "Niet bereikbaar";
  }

  try {
    const result = await fetchOsmCandidates(metering.points);
    osmCandidates = result.locations;
    osmUpdatedAt = result.updatedAt;
  } catch (error) {
    osmError = error instanceof Error ? error.message : "Niet bereikbaar";
  }

  const deduped = new Map<string, CandidateLocation>();
  for (const location of [...rwsAreas, ...osmCandidates]) {
    const key = `${location.road}:${Math.round(location.accessKm * 2) / 2}:${location.name.toLowerCase()}`;
    const previous = deduped.get(key);
    if (!previous || (location.source === "rws" && previous.source !== "rws")) deduped.set(key, location);
  }

  const allLocations = [...deduped.values()];
  rwsAreas = allLocations.filter(location => location.source === "rws");
  osmCandidates = allLocations.filter(location => location.source === "osm");

  staticCache = {
    expires: Date.now() + STATIC_TTL,
    sites,
    roadPoints: metering.points,
    rwsAreas,
    osmCandidates,
    siteUpdatedAt: siteFeed.updatedAt,
    meteringUpdatedAt: metering.updatedAt,
    rwsAreasUpdatedAt,
    osmUpdatedAt,
    rwsAreasError,
    osmError,
  };
  return staticCache;
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
      latitude: chunk.map(x => x.lat).join(","),
      longitude: chunk.map(x => x.lng).join(","),
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

const segmentId = (seg: Segment) => `${seg.road}-${seg.kmFrom}-${seg.kmTo}`;

export async function GET() {
  const generatedAt = new Date().toISOString();
  let staticContext: StaticContext | null = null;
  try { staticContext = await getStaticContext(); } catch { staticContext = null; }

  const sites = staticContext?.sites ?? [];
  const candidates = [...(staticContext?.rwsAreas ?? []), ...(staticContext?.osmCandidates ?? [])];

  const sources: SourceStatus[] = [
    { id: "ndw-sites", name: "NDW fysieke meetlocaties", ok: sites.length > 0, updatedAt: staticContext?.siteUpdatedAt ?? null, error: sites.length ? null : "Geen A-wegmeetpunten gekoppeld", lineage: "NDW AVG meetlocaties" },
    { id: "rws-metering", name: "RWS A-wegmetrering", ok: (staticContext?.roadPoints.length ?? 0) > 0, updatedAt: staticContext?.meteringUpdatedAt ?? null, error: (staticContext?.roadPoints.length ?? 0) ? null : "RWS metrering niet beschikbaar", lineage: "Rijkswaterstaat NWB metrering" },
    { id: "ndw-flow", name: "NDW snelheid + intensiteit", ok: false, updatedAt: null, error: null, lineage: "NDW/RWS fysieke detectoren" },
    { id: "rws-matrix", name: "RWS matrixsignalen", ok: false, updatedAt: null, error: null, lineage: "RWS wegkantsystemen via NDW" },
    { id: "ndw-current", name: "NDW Actueel Beeld", ok: false, updatedAt: null, error: null, lineage: "NDW situatiepublicatie" },
    { id: "rws-locations", name: "RWS stand-bylocaties", ok: (staticContext?.rwsAreas.length ?? 0) > 0, updatedAt: staticContext?.rwsAreasUpdatedAt ?? null, error: staticContext?.rwsAreasError ?? ((staticContext?.rwsAreas.length ?? 0) ? null : "Geen RWS locaties gevonden"), lineage: "Rijkswaterstaat GeoData" },
    { id: "osm-locations", name: "OSM nabijgelegen locaties", ok: (staticContext?.osmCandidates.length ?? 0) > 0, updatedAt: staticContext?.osmUpdatedAt ?? null, error: staticContext?.osmError ?? ((staticContext?.osmCandidates.length ?? 0) ? null : "Geen OSM kandidaten gevonden"), lineage: "OpenStreetMap via Overpass" },
    { id: "weather", name: "Open-Meteo weer", ok: false, updatedAt: null, error: null, lineage: "Open-Meteo" },
  ];

  let events = parseEvents("");
  let matrix = parseMatrix("");
  let samples: SiteTraffic[] = [];
  const siteMap = new Map(sites.map(site => [site.id, site]));

  await Promise.all([
    fetchTrafficStreaming(siteMap)
      .then(result => {
        samples = result.samples;
        sources[2] = { ...sources[2], ok: samples.length > 0, updatedAt: result.updatedAt, error: samples.length ? null : "Geen verse detectorwaarden" };
      })
      .catch(error => { sources[2].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
    fetchText(URLS.matrix, 20)
      .then(result => {
        matrix = parseMatrix(result.text);
        sources[3] = { ...sources[3], ok: true, updatedAt: result.updatedAt };
      })
      .catch(error => { sources[3].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
    fetchText(URLS.current, 20)
      .then(result => {
        events = parseEvents(result.text);
        sources[4] = { ...sources[4], ok: true, updatedAt: result.updatedAt ?? (stripTags(tagValue(result.text, "publicationTime") ?? "") || null) };
      })
      .catch(error => { sources[4].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
  ]);

  const segments = buildSegments(sites);
  let weather = new Map<string, WeatherSnapshot>();
  try {
    weather = await weatherMap(segments.map(seg => ({ id: segmentId(seg), lat: seg.lat, lng: seg.lng })));
    sources[7] = { ...sources[7], ok: weather.size > 0, updatedAt: [...weather.values()][0]?.observedAt ?? generatedAt };
  } catch (error) {
    sources[7].error = error instanceof Error ? error.message : "Niet bereikbaar";
  }

  const sampleMap = new Map(samples.map(sample => [sample.siteId, sample]));
  const scored = segments.map(seg => {
    const sensor = sensorMetrics(seg, sampleMap);
    const msi = segmentMatrix(matrix, seg);
    const incident = segmentEvents(seg, events);
    const localWeather = weather.get(segmentId(seg)) ?? null;
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
    const confidence: StandbyAdvice["confidence"] = highCoverage && corroboratingSignals >= 2 && sources[2].ok && sources[3].ok
      ? "hoog"
      : sensor.sensorCount >= 1 && corroboratingSignals >= 1 ? "middel" : "laag";

    return { seg, sensor, msi, incident, localWeather, corroboratingSignals, score, confidence };
  }).sort((a, b) => b.score - a.score || b.corroboratingSignals - a.corroboratingSignals);

  const advice: StandbyAdvice[] = [];
  const chosenLocations: CandidateLocation[] = [];

  for (const item of scored) {
    const match = chooseDynamicStandby(item.seg, candidates, chosenLocations);
    if (!match) continue;
    chosenLocations.push(match.location);

    const pressure: StandbyAdvice["pressure"] = item.score >= 65 ? "hoog" : item.score >= 38 ? "verhoogd" : "rustig";
    const maxSnap = item.seg.sites.length ? Math.max(...item.seg.sites.map(site => site.mappingDistanceMeters)) : 0;
    const locationType = match.location.source === "rws" ? "officiële RWS-verzorgingsplaats" : `${match.location.kind}-locatie uit OpenStreetMap`;

    const reasons = [
      `${item.seg.road} km ${item.seg.kmFrom}–${item.seg.kmTo}: vast segment van exact 5 km`,
      item.sensor.sensorCount
        ? `${item.sensor.sensorCount} verse fysieke detector(en), ${item.sensor.directionCount} rijrichtinggroep(en): ${item.sensor.averageSpeedKph ?? "—"} km/u mediaan${item.sensor.flowVehiclesPerHour !== null ? `, ${item.sensor.flowVehiclesPerHour} vtg/u mediaan` : ""}`
        : "geen verse fysieke snelheid/intensiteit — hoge score automatisch geblokkeerd",
      `meetpunten zijn aan officiële RWS A-wegmetrering gekoppeld (max. snapafstand ${maxSnap} m)`,
      item.msi.clusters ? `${item.msi.clusters} matrixcluster(s) uitsluitend binnen dit hectometerbereik` : "geen actieve matrixmaatregelen binnen dit 5-km-deel",
      item.incident.accidents ? `${item.incident.accidents} actueel ongeval(len) ruimtelijk bij dit wegdeel` : null,
      item.incident.obstructions ? `${item.incident.obstructions} actuele blokkade(s)/obstakels ruimtelijk bij dit wegdeel` : null,
      item.corroboratingSignals >= 2 ? `${item.corroboratingSignals} verschillende actuele signalen bevestigen de druk` : "onvoldoende bronbevestiging voor hoge zekerheid",
      `stand-byplek automatisch gekozen ná de live score: ${locationType}, circa ${match.roadDistance.toFixed(1)} km langs dezelfde A-weg van het segmentcentrum`,
    ].filter((x): x is string => Boolean(x));

    advice.push({
      id: segmentId(item.seg), road: item.seg.road, segmentName: `${item.seg.road} km ${item.seg.kmFrom}–${item.seg.kmTo}`,
      kmFrom: item.seg.kmFrom, kmTo: item.seg.kmTo, score: item.score, pressure, confidence: item.confidence,
      recommendedUnits: item.score >= 72 && item.confidence !== "laag" ? 2 : item.score >= 38 ? 1 : 0,
      sensorCount: item.sensor.sensorCount, averageSpeedKph: item.sensor.averageSpeedKph,
      flowVehiclesPerHour: item.sensor.flowVehiclesPerHour, congestionIndex: item.sensor.congestionIndex,
      localEvents: item.incident.items.length, accidents: item.incident.accidents, obstructions: item.incident.obstructions,
      matrixClusters: item.msi.clusters, lowSpeedMatrixClusters: item.msi.lowSpeed,
      corroboratingSignals: item.corroboratingSignals, reasons, weather: item.localWeather,
      standby: {
        id: match.location.id, name: match.location.name, address: match.location.address,
        lat: match.location.lat, lng: match.location.lng, kind: match.location.kind,
        source: match.location.source, verified: match.location.verified,
      },
    });

    if (advice.length >= 30) break;
  }

  const byRoad = matrixSummary(matrix);
  const activeSignals = byRoad.reduce((sum, row) => sum + row.active, 0);

  return NextResponse.json({
    generatedAt, refreshAfterSeconds: 30, region: "Noord-Brabant + Gelderland", events, advice, sources,
    matrix: { activeSignals, byRoad },
    meta: {
      eventCount: events.length,
      accidentCount: events.filter(x => x.kind === "accident").length,
      obstructionCount: events.filter(x => x.kind === "obstruction").length,
      trafficCount: events.filter(x => x.kind === "traffic").length,
      closureCount: events.filter(x => x.kind === "closure").length,
      segmentCount: segments.length,
      measuredSiteCount: samples.length,
      candidateLocationCount: candidates.length,
      rushHour: rushHour(),
      modelVersion: "0.5-dynamic-standby-fusion",
      note: `Alle ${segments.length} segmenten worden eerst live gescoord. Daarna kiest de engine vanuit ${candidates.length} locatiekandidaten automatisch de beste stand-byplek bij de zwaarste segmenten. Er zijn geen handmatig vastgezette voorbeeldlocaties meer.`,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}