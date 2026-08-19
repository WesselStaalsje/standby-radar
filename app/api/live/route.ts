import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import type {
  MatrixRoadSummary,
  SourceStatus,
  StandbyAdvice,
  StandbyLocation,
  TrafficEvent,
  TrafficKind,
  WeatherSnapshot,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NDW_CURRENT_URL = "https://opendata.ndw.nu/actueel_beeld.xml.gz";
const NDW_MSI_URL = "https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

const REGION = { minLat: 51.15, maxLat: 52.30, minLng: 4.20, maxLng: 6.55 };
const SEGMENT_LENGTH_KM = 5;
const MAX_STANDBY_ROAD_DISTANCE_KM = 15;

type CandidateLocation = StandbyLocation & {
  roadPositions: Array<{ road: string; km: number }>;
};

type RoadRange = {
  road: string;
  from: number;
  to: number;
};

type MatrixSignal = {
  signId: string;
  road: string | null;
  carriageway: string | null;
  lane: number | null;
  km: number | null;
  display: "speed" | "lane_closed" | "lane_closed_ahead" | "lane_open" | "restriction_end" | "blank" | "unknown";
  speedLimit: number | null;
};

const STANDBY_LOCATIONS: CandidateLocation[] = [
  {
    id: "gouden-leeuw-zevenbergschen-hoek",
    name: "De Gouden Leeuw",
    address: "Moerdijkseweg 1, 4765 SJ Zevenbergschen Hoek",
    lat: 51.685051,
    lng: 4.656334,
    kind: "restaurant",
    knownOperationalLocation: true,
    roadPositions: [{ road: "A16", km: 50.5 }],
  },
  {
    id: "wouwse-tol-noord",
    name: "Wouwse Tol Noord",
    address: "Rijksweg A58 11, 4623 RM Bergen op Zoom",
    lat: 51.505325,
    lng: 4.349858,
    kind: "service_area",
    knownOperationalLocation: true,
    roadPositions: [{ road: "A58", km: 101.2 }],
  },
  {
    id: "mcdonalds-beuningen",
    name: "McDonald's Beuningen",
    address: "Hadrianussingel 37, 6642 AH Beuningen",
    lat: 51.855783,
    lng: 5.751205,
    kind: "restaurant",
    knownOperationalLocation: true,
    roadPositions: [{ road: "A73", km: 112.0 }],
  },
];

// Eerste corridors rond gevalideerde operationele stand-byplaatsen.
// Nieuwe locaties kunnen later aan dezelfde 5-km segmentstructuur worden toegevoegd.
const ROAD_RANGES: RoadRange[] = [
  { road: "A16", from: 40, to: 70 },
  { road: "A58", from: 85, to: 110 },
  { road: "A73", from: 95, to: 115 },
];

const decodeXml = (value: string) => value
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'");

const stripTags = (value: string) => decodeXml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

const tagValue = (xml: string, tag: string) => {
  const rx = new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${tag}>`, "i");
  return rx.exec(xml)?.[1] ?? null;
};

const hasTag = (xml: string, tag: string) => new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${tag}\\b`, "i").test(xml);

const numberTag = (xml: string, tag: string) => {
  const raw = tagValue(xml, tag);
  if (raw === null) return null;
  const value = Number(stripTags(raw).replace(",", "."));
  return Number.isFinite(value) ? value : null;
};

const attr = (attributes: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]+)"`, "i").exec(attributes)?.[1] ?? null;

const classify = (type: string, body: string): TrafficKind | null => {
  const value = type.toLowerCase();
  if (value.includes("abnormaltraffic")) return "traffic";
  if (value.includes("accident")) return "accident";
  if (value.includes("vehicleobstruction") || value.includes("generalobstruction") || value.includes("animalpresence")) return "obstruction";
  if (value.includes("maintenanceworks") || value.includes("constructionworks")) return "works";
  if (value.includes("poorenvironment") || value.includes("weatherrelatedroad")) return "weather";
  if (value.includes("roadorcarriagewayorlanemanagement") && /closed|closure|blocked|laneClos|roadClos/i.test(body)) return "closure";
  return null;
};

const titleFor = (kind: TrafficKind, body: string) => {
  if (kind === "traffic") {
    const subtype = stripTags(tagValue(body, "abnormalTrafficType") ?? "");
    if (subtype === "stationaryTraffic") return "Stilstaand verkeer";
    if (subtype === "queuingTraffic") return "File";
    if (subtype === "slowTraffic") return "Langzaam verkeer";
    return "Afwijkend verkeersbeeld";
  }
  if (kind === "accident") return "Ongeval";
  if (kind === "obstruction") return "Obstakel / voertuig op de weg";
  if (kind === "closure") return "Afsluiting / rijstrookbeperking";
  if (kind === "works") return "Wegwerkzaamheden";
  return "Weers- of wegdekbelemmering";
};

const findCoordinates = (body: string) => {
  const preferred = tagValue(body, "coordinatesForDisplay") ?? tagValue(body, "pointCoordinates") ?? body;
  const lat = numberTag(preferred, "latitude");
  const lng = numberTag(preferred, "longitude");
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
};

const inRegion = (lat: number, lng: number) => lat >= REGION.minLat && lat <= REGION.maxLat && lng >= REGION.minLng && lng <= REGION.maxLng;

const roadRef = (body: string) => {
  for (const tag of ["roadNumber", "roadName", "roadNameAtOrigin", "roadNameAtDestination"]) {
    const raw = tagValue(body, tag);
    if (raw) {
      const match = /\b(?:A|N)\s?\d{1,3}\b/i.exec(stripTags(raw));
      if (match) return match[0].replace(/\s/g, "").toUpperCase();
    }
  }
  return null;
};

const sourceName = (body: string) => {
  const source = tagValue(body, "source");
  const value = source ? tagValue(source, "value") : null;
  return value ? stripTags(value).slice(0, 80) : null;
};

const freshEnough = (kind: TrafficKind, updatedAt: string | null) => {
  if (!updatedAt) return true;
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time)) return true;
  const ageMinutes = (Date.now() - time) / 60_000;
  const maxAge = kind === "works" || kind === "closure" ? 24 * 60 : kind === "weather" ? 6 * 60 : 180;
  return ageMinutes <= maxAge;
};

const parseEvents = (xml: string): TrafficEvent[] => {
  const events: TrafficEvent[] = [];
  const rx = /<(?:(?:[A-Za-z0-9_-]+):)?situationRecord\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?situationRecord>/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(xml))) {
    const attributes = match[1];
    const body = match[2];
    const rawType = attr(attributes, "xsi:type") ?? attr(attributes, "type") ?? "SituationRecord";
    const type = rawType.split(":").pop() ?? rawType;
    const kind = classify(type, body);
    if (!kind) continue;
    const coordinates = findCoordinates(body);
    if (!coordinates || !inRegion(coordinates.lat, coordinates.lng)) continue;
    const updatedRaw = tagValue(body, "situationRecordVersionTime") ?? tagValue(body, "situationRecordCreationTime");
    const updatedAt = updatedRaw ? stripTags(updatedRaw) : null;
    if (!freshEnough(kind, updatedAt)) continue;
    events.push({
      id: attr(attributes, "id") ?? `ndw-${events.length + 1}`,
      kind,
      title: titleFor(kind, body),
      type,
      lat: coordinates.lat,
      lng: coordinates.lng,
      roadRef: roadRef(body),
      queueLengthMeters: numberTag(body, "queueLength"),
      source: sourceName(body) ?? "NDW",
      updatedAt,
    });
  }
  return events.slice(0, 350);
};

const parseMatrix = (xml: string): MatrixSignal[] => {
  const bySign = new Map<string, MatrixSignal>();
  const rx = /<(?:(?:[A-Za-z0-9_-]+):)?event\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?event>/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(xml))) {
    const attributes = match[1];
    const body = match[2];
    const signId = stripTags(tagValue(body, "sign_id") ?? attr(attributes, "sign_id") ?? "");
    if (!signId) continue;
    const existing = bySign.get(signId) ?? {
      signId,
      road: null,
      carriageway: null,
      lane: null,
      km: null,
      display: "unknown" as const,
      speedLimit: null,
    };
    const road = tagValue(body, "road");
    const carriageway = tagValue(body, "carriageway");
    if (road) existing.road = stripTags(road).replace(/\s/g, "").toUpperCase();
    if (carriageway) existing.carriageway = stripTags(carriageway);
    existing.lane = numberTag(body, "lane") ?? existing.lane;
    existing.km = numberTag(body, "km") ?? existing.km;
    const speed = numberTag(body, "speedlimit");
    if (speed !== null) {
      existing.display = "speed";
      existing.speedLimit = speed;
    } else if (hasTag(body, "lane_closed_ahead")) {
      existing.display = "lane_closed_ahead";
      existing.speedLimit = null;
    } else if (hasTag(body, "lane_closed")) {
      existing.display = "lane_closed";
      existing.speedLimit = null;
    } else if (hasTag(body, "lane_open")) {
      existing.display = "lane_open";
      existing.speedLimit = null;
    } else if (hasTag(body, "restriction_end")) {
      existing.display = "restriction_end";
      existing.speedLimit = null;
    } else if (hasTag(body, "blank")) {
      existing.display = "blank";
      existing.speedLimit = null;
    }
    bySign.set(signId, existing);
  }
  return [...bySign.values()].filter((signal) => /^A\d{1,3}$/i.test(signal.road ?? ""));
};

const activeMatrix = (signal: MatrixSignal) => signal.display === "lane_closed" || signal.display === "lane_closed_ahead" || (signal.display === "speed" && (signal.speedLimit ?? 999) <= 90);

const matrixSummary = (signals: MatrixSignal[]): MatrixRoadSummary[] => {
  const roads = new Map<string, MatrixRoadSummary>();
  for (const signal of signals.filter(activeMatrix)) {
    if (!signal.road) continue;
    const item = roads.get(signal.road) ?? { road: signal.road, active: 0, closures: 0, lowSpeed: 0 };
    item.active += 1;
    if (signal.display === "lane_closed" || signal.display === "lane_closed_ahead") item.closures += 1;
    if (signal.display === "speed" && (signal.speedLimit ?? 999) <= 70) item.lowSpeed += 1;
    roads.set(signal.road, item);
  }
  return [...roads.values()].sort((a, b) => b.closures - a.closures || b.lowSpeed - a.lowSpeed || b.active - a.active).slice(0, 30);
};

const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

const eventImpact = (event: TrafficEvent) => {
  if (event.kind === "accident") return 13;
  if (event.kind === "closure") return 11;
  if (event.kind === "obstruction") return 7;
  if (event.kind === "traffic") return Math.min(14, 8 + Math.max(0, (event.queueLengthMeters ?? 0) / 1000) * 1.5);
  if (event.kind === "weather") return 5;
  return 2;
};

const buildSegments = () => ROAD_RANGES.flatMap((range) => {
  const segments: Array<{ road: string; kmFrom: number; kmTo: number; centerKm: number }> = [];
  for (let from = range.from; from < range.to; from += SEGMENT_LENGTH_KM) {
    const to = Math.min(range.to, from + SEGMENT_LENGTH_KM);
    segments.push({ road: range.road, kmFrom: from, kmTo: to, centerKm: (from + to) / 2 });
  }
  return segments;
});

const findStandby = (road: string, centerKm: number) => {
  const matches = STANDBY_LOCATIONS.flatMap((location) => location.roadPositions
    .filter((position) => position.road === road)
    .map((position) => ({ location, roadKm: position.km, distanceKm: Math.abs(position.km - centerKm) })));
  const best = matches.sort((a, b) => a.distanceKm - b.distanceKm)[0];
  return best && best.distanceKm <= MAX_STANDBY_ROAD_DISTANCE_KM ? best : null;
};

const segmentMatrixScore = (signals: MatrixSignal[], road: string, kmFrom: number, kmTo: number) => {
  const relevant = signals.filter((signal) => signal.road === road && signal.km !== null && signal.km >= kmFrom && signal.km < kmTo && activeMatrix(signal));
  const clusters = new Map<string, { score: number; low: boolean; closed: boolean }>();
  for (const signal of relevant) {
    const bucket = `${signal.carriageway ?? "?"}:${Math.floor((signal.km ?? 0) * 10) / 10}`;
    let score = 0;
    let low = false;
    let closed = false;
    if (signal.display === "lane_closed") { score = 8; closed = true; }
    else if (signal.display === "lane_closed_ahead") { score = 6; closed = true; }
    else if ((signal.speedLimit ?? 999) <= 50) { score = 5; low = true; }
    else if ((signal.speedLimit ?? 999) <= 70) { score = 3; low = true; }
    else if ((signal.speedLimit ?? 999) <= 90) score = 1;
    const old = clusters.get(bucket);
    if (!old || score > old.score) clusters.set(bucket, { score, low, closed });
  }
  const values = [...clusters.values()];
  return {
    score: Math.min(48, values.reduce((sum, value) => sum + value.score, 0)),
    clusters: values.length,
    lowSpeed: values.filter((value) => value.low).length,
    closures: values.filter((value) => value.closed).length,
  };
};

const rushHour = () => {
  const hour = Number(new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", hour12: false }).format(new Date()));
  return (hour >= 6 && hour < 10) || (hour >= 15 && hour < 19);
};

const weatherScore = (weather: WeatherSnapshot | null) => {
  if (!weather) return 0;
  let score = 0;
  if (weather.precipitation >= 2) score += 7;
  else if (weather.precipitation >= 0.2) score += 3;
  if (weather.windGusts >= 70) score += 6;
  else if (weather.windGusts >= 50) score += 3;
  if (weather.visibility > 0 && weather.visibility < 2000) score += 6;
  else if (weather.visibility > 0 && weather.visibility < 5000) score += 3;
  return Math.min(12, score);
};

const fetchXml = async (url: string) => {
  const response = await fetch(url, { cache: "no-store", headers: { "user-agent": "StandbyRadar/0.2" } });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return { text, updatedAt: response.headers.get("last-modified") };
};

const fetchWeather = async () => {
  const params = new URLSearchParams({
    latitude: STANDBY_LOCATIONS.map((location) => location.lat).join(","),
    longitude: STANDBY_LOCATIONS.map((location) => location.lng).join(","),
    current: "precipitation,wind_gusts_10m,visibility,weather_code",
    timezone: "Europe/Amsterdam",
  });
  const response = await fetch(`${OPEN_METEO_URL}?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const raw = await response.json() as unknown;
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item) => {
    const current = (item as { current?: Record<string, unknown> }).current ?? {};
    return {
      precipitation: Number(current.precipitation ?? 0),
      windGusts: Number(current.wind_gusts_10m ?? 0),
      visibility: Number(current.visibility ?? 0),
      weatherCode: current.weather_code === undefined ? null : Number(current.weather_code),
      observedAt: typeof current.time === "string" ? current.time : null,
    } satisfies WeatherSnapshot;
  });
};

export async function GET() {
  const generatedAt = new Date().toISOString();
  let events: TrafficEvent[] = [];
  let matrix: MatrixSignal[] = [];
  let weather: WeatherSnapshot[] = [];
  const sources: SourceStatus[] = [
    { id: "ndw-current", name: "NDW Actueel Beeld", ok: false, updatedAt: null, error: null },
    { id: "ndw-msi", name: "NDW Matrixsignalen", ok: false, updatedAt: null, error: null },
    { id: "weather", name: "Open-Meteo weer", ok: false, updatedAt: null, error: null },
  ];

  await Promise.all([
    fetchXml(NDW_CURRENT_URL).then(({ text, updatedAt }) => {
      events = parseEvents(text);
      sources[0] = { ...sources[0], ok: true, updatedAt: updatedAt ?? (stripTags(tagValue(text, "publicationTime") ?? "") || null) };
    }).catch((error) => { sources[0].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
    fetchXml(NDW_MSI_URL).then(({ text, updatedAt }) => {
      matrix = parseMatrix(text);
      sources[1] = { ...sources[1], ok: true, updatedAt };
    }).catch((error) => { sources[1].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
    fetchWeather().then((result) => {
      weather = result;
      sources[2] = { ...sources[2], ok: true, updatedAt: result[0]?.observedAt ?? generatedAt };
    }).catch((error) => { sources[2].error = error instanceof Error ? error.message : "Niet bereikbaar"; }),
  ]);

  const isRush = rushHour();
  const weatherByLocation = new Map(STANDBY_LOCATIONS.map((location, index) => [location.id, weather[index] ?? null]));

  const advice: StandbyAdvice[] = buildSegments().flatMap((segment) => {
    const standbyMatch = findStandby(segment.road, segment.centerKm);
    if (!standbyMatch) return [];
    const { location, roadKm, distanceKm: standbyRoadDistance } = standbyMatch;
    const msi = segmentMatrixScore(matrix, segment.road, segment.kmFrom, segment.kmTo);
    const local = events
      .map((event) => ({ event, distance: haversineKm(location, event) }))
      .filter((item) => item.distance <= 8 && (!item.event.roadRef || item.event.roadRef === segment.road))
      .sort((a, b) => a.distance - b.distance);
    const localImpacts = local
      .map((item) => eventImpact(item.event) * Math.max(0.15, 1 - item.distance / 9))
      .sort((a, b) => b - a)
      .slice(0, 3);
    const eventScore = Math.min(28, localImpacts.reduce((sum, value) => sum + value, 0));
    const proximityPenalty = Math.min(14, Math.round(standbyRoadDistance * 0.8));
    const currentWeather = weatherByLocation.get(location.id) ?? null;
    const score = Math.max(0, Math.min(96, Math.round(8 + (isRush ? 5 : 1) + msi.score + eventScore + weatherScore(currentWeather) - proximityPenalty)));
    const sourceCount = sources.filter((source) => source.ok).length;
    const confidence: StandbyAdvice["confidence"] = sourceCount === 3 && (msi.clusters > 0 || local.length > 0) ? "hoog" : sourceCount >= 2 ? "middel" : "laag";
    const pressure: StandbyAdvice["pressure"] = score >= 65 ? "hoog" : score >= 38 ? "verhoogd" : "rustig";
    const accidents = local.filter((item) => item.event.kind === "accident").length;
    const obstructions = local.filter((item) => item.event.kind === "obstruction" || item.event.kind === "closure").length;
    const reasons = [
      `${segment.road} km ${segment.kmFrom.toFixed(0)}–${segment.kmTo.toFixed(0)} wordt apart beoordeeld`,
      msi.clusters ? `${msi.clusters} actieve matrixclusters binnen precies dit 5-km segment` : "geen actieve matrixmaatregelen binnen dit 5-km segment",
      msi.lowSpeed ? `${msi.lowSpeed} clusters met 70 km/u of lager` : null,
      msi.closures ? `${msi.closures} cluster(s) met rijstrooksluiting` : null,
      accidents ? `${accidents} actueel ongeval(len) binnen 8 km van de stand-byplek` : null,
      obstructions ? `${obstructions} actuele blokkade(s) / obstakels nabij de stand-byplek` : null,
      `stand-byplek ligt circa ${Math.abs(roadKm - segment.centerKm).toFixed(1)} weg-km van het segmentmidden`,
      isRush ? "spitsfactor actief" : null,
    ].filter((reason): reason is string => Boolean(reason));

    return [{
      id: `${segment.road}-${segment.kmFrom}-${segment.kmTo}`,
      road: segment.road,
      segmentName: `${segment.road} km ${segment.kmFrom.toFixed(0)}–${segment.kmTo.toFixed(0)}`,
      kmFrom: segment.kmFrom,
      kmTo: segment.kmTo,
      centerLat: location.lat,
      centerLng: location.lng,
      score,
      pressure,
      confidence,
      recommendedUnits: score >= 72 ? 2 : score >= 38 ? 1 : 0,
      localEvents: local.length,
      accidents,
      obstructions,
      matrixClusters: msi.clusters,
      lowSpeedMatrixClusters: msi.lowSpeed,
      reasons,
      weather: currentWeather,
      standby: {
        id: location.id,
        name: location.name,
        address: location.address,
        lat: location.lat,
        lng: location.lng,
        kind: location.kind,
        knownOperationalLocation: location.knownOperationalLocation,
      },
    }];
  }).sort((a, b) => b.score - a.score || a.road.localeCompare(b.road) || a.kmFrom - b.kmFrom);

  const byRoad = matrixSummary(matrix);
  const activeSignals = byRoad.reduce((sum, item) => sum + item.active, 0);

  return NextResponse.json({
    generatedAt,
    refreshAfterSeconds: 60,
    region: "Noord-Brabant + Gelderland",
    events,
    advice,
    sources,
    matrix: { activeSignals, byRoad },
    meta: {
      eventCount: events.length,
      accidentCount: events.filter((event) => event.kind === "accident").length,
      obstructionCount: events.filter((event) => event.kind === "obstruction").length,
      trafficCount: events.filter((event) => event.kind === "traffic").length,
      closureCount: events.filter((event) => event.kind === "closure").length,
      segmentCount: advice.length,
      rushHour: isRush,
      modelVersion: "0.2-segment-5km",
      note: "Stand-by advies wordt nu per 5-km snelwegsegment berekend. Alleen segmenten met een bekende geschikte stand-byplek binnen 15 weg-km worden getoond; er worden geen willekeurige parkeerplaatsen als veilig aangenomen.",
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}