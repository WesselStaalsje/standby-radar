import { createGunzip, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import type { ImnRoadRange } from "@/lib/rayons";
import { normalizeDirection } from "@/lib/rayons";
import { loadImnSiteSnapshot } from "@/lib/imn-site-snapshot";
import type { MeasurementSite, RoadMetringPoint, SiteTraffic, MatrixSignal } from "@/lib/ndw";
import { parseMatrix, parseRoadMetringPoints, parseTrafficSamples } from "@/lib/ndw";
import { parseRwsVildCandidates, type CandidateLocation, type ScopedMeasurementSite, normalizeRoadDirection } from "@/lib/engine-v2";
import { NwbRoutingGraph, parseNwbRoadEdges, NWB_WEGVAKKEN_URL } from "@/lib/nwb-routing";
import { parseTravelTimeSampleV2, parseTravelTimeSiteV2, type TravelTimeSampleV2, type TravelTimeSiteV2 } from "@/lib/ndw-traveltime-v2";

const URLS = {
  traffic: "https://opendata.ndw.nu/trafficspeed.xml.gz",
  matrix: "https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz",
  measurementConfig: "https://opendata.ndw.nu/measurement_current.xml.gz",
  travelTime: "https://opendata.ndw.nu/traveltime.xml.gz",
  rwsMetering: "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/nwb_metrering/MapServer/2/query",
  rwsVild: "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/vild/FeatureServer",
};

const BBOX = { minLat: 51.15, minLng: 4.20, maxLat: 52.30, maxLng: 6.55 };
const STATIC_TTL = 6 * 60 * 60 * 1000;
const LIVE_TIMEOUT = 18_000;
const STATIC_TIMEOUT = 28_000;

export type V5StaticContext = {
  expires: number;
  generatedAt: string;
  ranges: ImnRoadRange[];
  codes: string[];
  sites: ScopedMeasurementSite[];
  roadPoints: RoadMetringPoint[];
  candidates: CandidateLocation[];
  graph: NwbRoutingGraph | null;
  nwbEdgeCount: number;
  travelSites: TravelTimeSiteV2[];
  meteringUpdatedAt: string | null;
  candidateUpdatedAt: string | null;
  nwbUpdatedAt: string | null;
  travelConfigUpdatedAt: string | null;
  errors: string[];
};

export type V5LiveContext = {
  samples: Map<string, SiteTraffic>;
  matrix: MatrixSignal[];
  travelSamples: Map<string, TravelTimeSampleV2>;
  trafficUpdatedAt: string | null;
  matrixUpdatedAt: string | null;
  travelUpdatedAt: string | null;
  errors: string[];
};

let staticCache: V5StaticContext | null = null;

async function streamGzipRecords(url: string, recordName: string, onRecord: (record: string) => void, timeoutMs: number, revalidate = 0) {
  const response = await fetch(url, {
    ...(revalidate > 0 ? { next: { revalidate } } : { cache: "no-store" as const }),
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "StandbyRadar/2.0" },
  });
  if (!response.ok || !response.body) throw new Error(`${recordName} HTTP ${response.status}`);
  const contentEncoding = response.headers.get("content-encoding") ?? "";
  const input = Readable.fromWeb(response.body as never);
  const decoded = /gzip/i.test(contentEncoding) ? input : input.pipe(createGunzip());
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

async function fetchCompressedText(url: string, revalidate: number, timeoutMs = LIVE_TIMEOUT) {
  const response = await fetch(url, {
    ...(revalidate > 0 ? { next: { revalidate } } : { cache: "no-store" as const }),
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "StandbyRadar/2.0" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer[0] === 31 && buffer[1] === 139 ? gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
  return { text, updatedAt: response.headers.get("last-modified") ?? response.headers.get("date") };
}

async function fetchRoadPoints() {
  const all: RoadMetringPoint[] = [];
  let offset = 0;
  let updatedAt: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const params = new URLSearchParams({
      where: "a_n_nr LIKE 'A%'",
      outFields: "wvk_id,a_n_nr,l_r,hectometer,hectomtrng",
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
      signal: AbortSignal.timeout(STATIC_TIMEOUT),
      headers: { "user-agent": "StandbyRadar/2.0" },
    });
    if (!response.ok) throw new Error(`RWS metrering HTTP ${response.status}`);
    updatedAt = response.headers.get("last-modified") ?? response.headers.get("date") ?? updatedAt;
    const json = await response.json() as { features?: unknown[] };
    all.push(...parseRoadMetringPoints(json));
    const count = json.features?.length ?? 0;
    if (count < 2000) break;
    offset += count;
  }
  const unique = new Map(all.map(point => [`${point.road}:${point.km}:${point.direction ?? ""}:${point.wvkId ?? ""}:${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`, point]));
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
    signal: AbortSignal.timeout(STATIC_TIMEOUT),
    headers: { "user-agent": "StandbyRadar/2.0" },
  });
  if (!response.ok) throw new Error(`RWS VILD ${layer} HTTP ${response.status}`);
  return { json: await response.json(), updatedAt: response.headers.get("last-modified") ?? response.headers.get("date") };
}

async function fetchNwbGraph() {
  const edges = [] as ReturnType<typeof parseNwbRoadEdges>;
  let offset = 0;
  let updatedAt: string | null = null;
  const pageSize = 1000;
  for (let page = 0; page < 40; page += 1) {
    const params = new URLSearchParams({
      where: "wegbehsrt='R'",
      outFields: "wvk_id,jte_id_beg,jte_id_end,wegnummer,rpe_code,admrichtng,rijrichtng,wegbehsrt",
      returnGeometry: "true",
      geometry: `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outSR: "4326",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: "geojson",
    });
    const response = await fetch(`${NWB_WEGVAKKEN_URL}?${params}`, {
      next: { revalidate: 21600 },
      signal: AbortSignal.timeout(STATIC_TIMEOUT),
      headers: { "user-agent": "StandbyRadar/2.0" },
    });
    if (!response.ok) throw new Error(`NWB wegvakken HTTP ${response.status}`);
    updatedAt = response.headers.get("last-modified") ?? response.headers.get("date") ?? updatedAt;
    const json = await response.json() as { features?: unknown[] };
    edges.push(...parseNwbRoadEdges(json));
    const count = json.features?.length ?? 0;
    if (count < pageSize) break;
    offset += count;
  }
  const unique = new Map(edges.map(edge => [edge.wvkId, edge]));
  const values = [...unique.values()];
  return { graph: values.length ? new NwbRoutingGraph(values) : null, count: values.length, updatedAt };
}

const exactRangeFor = (road: string, km: number, direction: unknown, ranges: ImnRoadRange[]) => {
  const normalized = normalizeDirection(String(direction ?? ""));
  if (normalized) return ranges.find(range => range.road === road && range.direction === normalized && km >= range.fromKm && km <= range.toKm) ?? null;
  const candidates = ranges.filter(range => range.road === road && km >= range.fromKm && km <= range.toKm);
  const rayons = [...new Set(candidates.map(range => range.rayon))];
  return rayons.length === 1 ? candidates[0] ?? null : null;
};

const scopeCandidates = (items: CandidateLocation[], ranges: ImnRoadRange[]) => items.flatMap(item => {
  const range = exactRangeFor(item.road, item.accessKm, item.direction, ranges);
  return range ? [{ ...item, rayon: range.rayon, direction: normalizeRoadDirection(item.direction) }] : [];
});

export async function loadV5Static(): Promise<V5StaticContext> {
  if (staticCache && staticCache.expires > Date.now()) return staticCache;
  const snapshot = loadImnSiteSnapshot();
  const errors: string[] = [];
  const [meteringResult, vildResult, nwbResult] = await Promise.allSettled([
    fetchRoadPoints(),
    Promise.all([fetchVild(18), fetchVild(19), fetchVild(23)]),
    fetchNwbGraph(),
  ]);
  if (meteringResult.status !== "fulfilled") throw meteringResult.reason;
  const roadPoints = meteringResult.value.points;
  const ranges = snapshot.ranges;
  const sites: ScopedMeasurementSite[] = snapshot.sites.flatMap(site => {
    const range = exactRangeFor(site.road, site.km, site.direction, ranges);
    return range ? [{ ...site, rayon: range.rayon, rangeFromKm: range.fromKm, rangeToKm: range.toKm }] : [];
  });

  let candidates: CandidateLocation[] = [];
  let candidateUpdatedAt: string | null = null;
  if (vildResult.status === "fulfilled") {
    const [parking, service, fuel] = vildResult.value;
    candidates = scopeCandidates([
      ...parseRwsVildCandidates(parking.json, roadPoints, "parking", "parkeerplaats"),
      ...parseRwsVildCandidates(service.json, roadPoints, "service_area", "serviceplaats"),
      ...parseRwsVildCandidates(fuel.json, roadPoints, "fuel", "tankstation"),
    ], ranges);
    candidateUpdatedAt = parking.updatedAt ?? service.updatedAt ?? fuel.updatedAt;
  } else errors.push(vildResult.reason instanceof Error ? vildResult.reason.message : "RWS VILD niet bereikbaar");

  const graph = nwbResult.status === "fulfilled" ? nwbResult.value.graph : null;
  const nwbEdgeCount = nwbResult.status === "fulfilled" ? nwbResult.value.count : 0;
  const nwbUpdatedAt = nwbResult.status === "fulfilled" ? nwbResult.value.updatedAt : null;
  if (nwbResult.status !== "fulfilled") errors.push(nwbResult.reason instanceof Error ? nwbResult.reason.message : "NWB graph niet bereikbaar");

  const travelSites: TravelTimeSiteV2[] = [];
  let travelConfigUpdatedAt: string | null = null;
  try {
    travelConfigUpdatedAt = await streamGzipRecords(URLS.measurementConfig, "measurementSiteRecord", record => {
      const site = parseTravelTimeSiteV2(record, roadPoints);
      if (!site) return;
      const center = (site.kmFrom + site.kmTo) / 2;
      if (exactRangeFor(site.road, center, site.direction, ranges)) travelSites.push(site);
    }, STATIC_TIMEOUT, 21600);
  } catch (error) {
    errors.push(error instanceof Error ? `NDW reistijdconfig: ${error.message}` : "NDW reistijdconfig niet bereikbaar");
  }

  staticCache = {
    expires: Date.now() + STATIC_TTL,
    generatedAt: snapshot.generatedAt,
    ranges,
    codes: snapshot.codes,
    sites,
    roadPoints,
    candidates,
    graph,
    nwbEdgeCount,
    travelSites,
    meteringUpdatedAt: meteringResult.value.updatedAt,
    candidateUpdatedAt,
    nwbUpdatedAt,
    travelConfigUpdatedAt,
    errors,
  };
  return staticCache;
}

async function fetchTraffic(sites: ScopedMeasurementSite[]) {
  const siteMap = new Map<string, MeasurementSite>(sites.map(site => [site.id, site]));
  const samples = new Map<string, SiteTraffic>();
  const updatedAt = await streamGzipRecords(URLS.traffic, "siteMeasurements", record => {
    for (const sample of parseTrafficSamples(record, siteMap)) samples.set(sample.siteId, sample);
  }, LIVE_TIMEOUT);
  return { samples, updatedAt };
}

async function fetchMatrix(ranges: ImnRoadRange[]) {
  const result = await fetchCompressedText(URLS.matrix, 20);
  const matrix = parseMatrix(result.text).filter(signal => {
    if (!signal.road || signal.km === null) return false;
    const direction = normalizeDirection(signal.carriageway);
    return Boolean(exactRangeFor(signal.road, signal.km, direction, ranges));
  });
  return { matrix, updatedAt: result.updatedAt };
}

async function fetchTravelTimes(sites: TravelTimeSiteV2[]) {
  const samples = new Map<string, TravelTimeSampleV2>();
  const siteMap = new Map(sites.map(site => [site.id, site]));
  if (!siteMap.size) return { samples, updatedAt: null };
  const updatedAt = await streamGzipRecords(URLS.travelTime, "siteMeasurements", record => {
    const sample = parseTravelTimeSampleV2(record, siteMap);
    if (sample) samples.set(sample.siteId, sample);
  }, LIVE_TIMEOUT);
  return { samples, updatedAt };
}

export async function loadV5Live(context: V5StaticContext): Promise<V5LiveContext> {
  const errors: string[] = [];
  const [trafficResult, matrixResult, travelResult] = await Promise.allSettled([
    fetchTraffic(context.sites),
    fetchMatrix(context.ranges),
    fetchTravelTimes(context.travelSites),
  ]);
  if (trafficResult.status !== "fulfilled") errors.push(trafficResult.reason instanceof Error ? `NDW detectoren: ${trafficResult.reason.message}` : "NDW detectoren niet bereikbaar");
  if (matrixResult.status !== "fulfilled") errors.push(matrixResult.reason instanceof Error ? `RWS matrix: ${matrixResult.reason.message}` : "RWS matrix niet bereikbaar");
  if (travelResult.status !== "fulfilled") errors.push(travelResult.reason instanceof Error ? `NDW reistijd: ${travelResult.reason.message}` : "NDW reistijd niet bereikbaar");
  return {
    samples: trafficResult.status === "fulfilled" ? trafficResult.value.samples : new Map(),
    matrix: matrixResult.status === "fulfilled" ? matrixResult.value.matrix : [],
    travelSamples: travelResult.status === "fulfilled" ? travelResult.value.samples : new Map(),
    trafficUpdatedAt: trafficResult.status === "fulfilled" ? trafficResult.value.updatedAt : null,
    matrixUpdatedAt: matrixResult.status === "fulfilled" ? matrixResult.value.updatedAt : null,
    travelUpdatedAt: travelResult.status === "fulfilled" ? travelResult.value.updatedAt : null,
    errors,
  };
}

export function rangeForPoint(point: Pick<RoadMetringPoint, "road" | "km" | "direction">, ranges: ImnRoadRange[]) {
  return exactRangeFor(point.road, point.km, point.direction, ranges);
}

export function exactRange(road: string, km: number, direction: unknown, ranges: ImnRoadRange[]) {
  return exactRangeFor(road, km, direction, ranges);
}
