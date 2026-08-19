import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import type { MatrixRoadSummary, SourceStatus, StandbyAdvice, TrafficEvent, TrafficKind, WeatherSnapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NDW_CURRENT_URL = "https://opendata.ndw.nu/actueel_beeld.xml.gz";
const NDW_MSI_URL = "https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

const REGION = { minLat: 51.15, maxLat: 52.30, minLng: 4.25, maxLng: 6.55 };

const ZONES = [
  { id: "eindhoven-best", name: "Eindhoven-Noord / Best", province: "Noord-Brabant", lat: 51.505, lng: 5.445, roads: ["A2", "A50", "A58"] },
  { id: "den-bosch", name: "'s-Hertogenbosch", province: "Noord-Brabant", lat: 51.704, lng: 5.337, roads: ["A2", "A59"] },
  { id: "paalgraven", name: "Paalgraven / Oss", province: "Noord-Brabant", lat: 51.75, lng: 5.53, roads: ["A50", "A59"] },
  { id: "breda", name: "Breda", province: "Noord-Brabant", lat: 51.565, lng: 4.755, roads: ["A16", "A27", "A58"] },
  { id: "tilburg", name: "Tilburg", province: "Noord-Brabant", lat: 51.565, lng: 5.045, roads: ["A58", "A65"] },
  { id: "deil", name: "Deil", province: "Gelderland", lat: 51.885, lng: 5.245, roads: ["A2", "A15"] },
  { id: "valburg", name: "Valburg / Elst", province: "Gelderland", lat: 51.91, lng: 5.79, roads: ["A15", "A50", "A325"] },
  { id: "arnhem", name: "Arnhem / Grijsoord", province: "Gelderland", lat: 52.01, lng: 5.82, roads: ["A12", "A50"] },
  { id: "ede", name: "Ede / Maanderbroek", province: "Gelderland", lat: 52.025, lng: 5.65, roads: ["A12", "A30"] },
  { id: "apeldoorn", name: "Apeldoorn / Beekbergen", province: "Gelderland", lat: 52.155, lng: 5.965, roads: ["A1", "A50"] },
] as const;

type MatrixSignal = {
  signId: string;
  road: string | null;
  carriageway: string | null;
  lane: number | null;
  km: number | null;
  display: "speed" | "lane_closed" | "lane_closed_ahead" | "lane_open" | "restriction_end" | "blank" | "unknown";
  speedLimit: number | null;
};

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
  const value = Number(stripTags(raw));
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
  for (const tag of ["roadNumber", "roadName"]) {
    const raw = tagValue(body, tag);
    if (raw) {
      const match = /\b(?:A|N)\s?\d{1,3}\b/i.exec(stripTags(raw));
      if (match) return match[0].replace(/\s/g, "").toUpperCase();
    }
  }
  const match = /\b(?:A|N)\s?\d{1,3}\b/i.exec(stripTags(body));
  return match ? match[0].replace(/\s/g, "").toUpperCase() : null;
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
  const maxAge = kind === "works" || kind === "closure" ? 24 * 60 : kind === "weather" ? 6 * 60 : 3 * 60;
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

const impact = (event: TrafficEvent) => {
  if (event.kind === "accident") return 16;
  if (event.kind === "closure") return 13;
  if (event.kind === "obstruction") return 10;
  if (event.kind === "traffic") return Math.min(13, 7 + Math.max(0, (event.queueLengthMeters ?? 0) / 1000) * 1.5);
  if (event.kind === "weather") return 6;
  return 3;
};

const matrixScore = (signals: MatrixSignal[], roads: readonly string[]) => {
  const clusters = new Map<string, number>();
  for (const signal of signals.filter(activeMatrix)) {
    if (!signal.road || !roads.includes(signal.road)) continue;
    const bucket = signal.km === null ? signal.signId : (Math.round(signal.km * 2) / 2).toFixed(1);
    const key = `${signal.road}:${signal.carriageway ?? "?"}:${bucket}`;
    let value = 0;
    if (signal.display === "lane_closed") value = 3.5;
    else if (signal.display === "lane_closed_ahead") value = 2.5;
    else if ((signal.speedLimit ?? 999) <= 50) value = 1.4;
    else if ((signal.speedLimit ?? 999) <= 70) value = 0.9;
    else if ((signal.speedLimit ?? 999) <= 90) value = 0.4;
    clusters.set(key, Math.max(clusters.get(key) ?? 0, value));
  }
  return { clusters: clusters.size, score: Math.min(14, [...clusters.values()].reduce((sum, value) => sum + value, 0)) };
};

const weatherScore = (weather: WeatherSnapshot | null) => {
  if (!weather) return 0;
  let score = 0;
  if (weather.precipitation >= 5) score += 12;
  else if (weather.precipitation >= 2) score += 8;
  else if (weather.precipitation >= 0.5) score += 5;
  else if (weather.precipitation > 0) score += 2;
  if (weather.windGusts >= 80) score += 8;
  else if (weather.windGusts >= 60) score += 5;
  else if (weather.windGusts >= 45) score += 3;
  if (weather.visibility > 0 && weather.visibility < 1500) score += 7;
  else if (weather.visibility > 0 && weather.visibility < 4000) score += 4;
  return Math.min(22, score);
};

const rushHour = () => {
  const hour = Number(new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  return (hour >= 7 && hour < 10) || (hour >= 15 && hour < 19);
};

const reasonsFor = (nearby: { event: TrafficEvent; distance: number }[], matrixClusters: number, weather: WeatherSnapshot | null, isRush: boolean) => {
  const reasons: string[] = [];
  const accidents = nearby.filter((item) => item.event.kind === "accident");
  const obstructions = nearby.filter((item) => item.event.kind === "obstruction" || item.event.kind === "closure");
  const traffic = nearby.filter((item) => item.event.kind === "traffic");
  if (accidents.length) reasons.push(`${accidents.length} actueel ongeval${accidents.length === 1 ? "" : "len"} in de omgeving`);
  if (obstructions.length) reasons.push(`${obstructions.length} actuele blokkade${obstructions.length === 1 ? "" : "s"} / obstakels`);
  if (traffic.length) reasons.push(`${traffic.length} live file-/vertragingssignaal${traffic.length === 1 ? "" : "en"}`);
  if (matrixClusters) reasons.push(`${matrixClusters} actieve matrixcluster${matrixClusters === 1 ? "" : "s"} op relevante A-wegen`);
  if ((weather?.precipitation ?? 0) >= 0.5) reasons.push(`${weather!.precipitation.toLocaleString("nl-NL", { maximumFractionDigits: 1 })} mm neerslag`);
  if ((weather?.windGusts ?? 0) >= 45) reasons.push(`windstoten rond ${Math.round(weather!.windGusts)} km/u`);
  if (isRush) reasons.push("spitsfactor actief");
  if (!reasons.length) reasons.push("geen sterke actuele risicosignalen");
  return reasons.slice(0, 4);
};

const fetchXml = async (url: string) => {
  const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/xml,*/*", "User-Agent": "StandbyRadar/0.1" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return { text, updatedAt: response.headers.get("last-modified") };
};

const fetchWeather = async (): Promise<WeatherSnapshot[]> => {
  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set("latitude", ZONES.map((zone) => zone.lat).join(","));
  url.searchParams.set("longitude", ZONES.map((zone) => zone.lng).join(","));
  url.searchParams.set("current", "precipitation,weather_code,wind_gusts_10m,visibility");
  url.searchParams.set("timezone", "Europe/Amsterdam");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json() as unknown;
  const rows = Array.isArray(json) ? json : [json];
  return rows.map((row) => {
    const current = (row as { current?: Record<string, unknown> }).current ?? {};
    return {
      precipitation: Number(current.precipitation ?? 0),
      windGusts: Number(current.wind_gusts_10m ?? 0),
      visibility: Number(current.visibility ?? 10_000),
      weatherCode: Number.isFinite(Number(current.weather_code)) ? Number(current.weather_code) : null,
      observedAt: typeof current.time === "string" ? current.time : null,
    };
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
  const advice: StandbyAdvice[] = ZONES.map((zone, index) => {
    const nearby = events
      .map((event) => ({ event, distance: haversineKm(zone, event) }))
      .filter((item) => item.distance <= 45)
      .sort((a, b) => a.distance - b.distance);
    const strongest = nearby
      .map((item) => impact(item.event) * Math.max(0.12, 1 - item.distance / 50))
      .sort((a, b) => b - a)
      .slice(0, 5);
    const eventScore = Math.min(45, strongest.reduce((sum, value) => sum + value, 0));
    const msi = matrixScore(matrix, zone.roads);
    const currentWeather = weather[index] ?? null;
    const score = Math.min(96, Math.round(8 + (isRush ? 8 : 2) + eventScore + msi.score + weatherScore(currentWeather)));
    const sourceCount = sources.filter((source) => source.ok).length;
    const confidence: StandbyAdvice["confidence"] = sourceCount === 3 && nearby.length ? "hoog" : sourceCount >= 2 ? "middel" : "laag";
    return {
      ...zone,
      score,
      confidence,
      recommendedUnits: score >= 80 ? 2 : score >= 52 ? 1 : 0,
      nearbyEvents: nearby.length,
      matrixClusters: msi.clusters,
      reasons: reasonsFor(nearby, msi.clusters, currentWeather, isRush),
      weather: currentWeather,
    };
  }).sort((a, b) => b.score - a.score);

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
      rushHour: isRush,
      modelVersion: "0.1-live",
      note: "Adviespunten zijn corridorzones, nog geen gevalideerde parkeerlocaties. Gebruik het advies als beslisondersteuning en niet als automatische inzetopdracht.",
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
