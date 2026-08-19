import type { MatrixRoadSummary, TrafficEvent, TrafficKind } from "@/lib/types";

export const TARGET_ROADS = new Set([
  "A1", "A2", "A4", "A12", "A15", "A16", "A17", "A18", "A27", "A28", "A29", "A30",
  "A50", "A58", "A59", "A65", "A67", "A73", "A270", "A325", "A326", "A348", "A783",
]);
const REGION = { minLat: 51.15, maxLat: 52.30, minLng: 4.20, maxLng: 6.55 };

export type MatrixSignal = {
  signId: string;
  road: string | null;
  carriageway: string | null;
  lane: number | null;
  km: number | null;
  display: "speed" | "lane_closed" | "lane_closed_ahead" | "lane_open" | "restriction_end" | "blank" | "unknown";
  speedLimit: number | null;
};

export type RawMeasurementSite = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  speedIndexes: Set<number>;
  flowIndexes: Set<number>;
};

export type MeasurementSite = RawMeasurementSite & {
  road: string;
  km: number;
  direction: string | null;
  mappingDistanceMeters: number;
  wvkId?: number | null;
};

export type RoadMetringPoint = {
  road: string;
  km: number;
  lat: number;
  lng: number;
  direction: string | null;
  wvkId: number | null;
};

export type SiteTraffic = {
  siteId: string;
  measuredAt: string;
  speedKph: number | null;
  flowVehiclesPerHour: number | null;
  qualityScore?: number | null;
  inputValues?: number | null;
  incompleteInputs?: number | null;
};

type SiteConfig = Pick<RawMeasurementSite, "id" | "speedIndexes" | "flowIndexes">;

const decode = (value: string) => value
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'");

export const stripTags = (value: string) => decode(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
export const tagValue = (xml: string, tag: string) => new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${tag}>`, "i").exec(xml)?.[1] ?? null;
const hasTag = (xml: string, tag: string) => new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${tag}\\b`, "i").test(xml);
const attr = (text: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]+)"`, "i").exec(text)?.[1] ?? null;
const numberTag = (xml: string, tag: string) => {
  const raw = tagValue(xml, tag);
  if (raw === null) return null;
  const value = Number(stripTags(raw).replace(",", "."));
  return Number.isFinite(value) ? value : null;
};
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const inRegion = (lat: number, lng: number) => lat >= REGION.minLat && lat <= REGION.maxLat && lng >= REGION.minLng && lng <= REGION.maxLng;
const coords = (body: string) => {
  const source = tagValue(body, "coordinatesForDisplay") ?? tagValue(body, "locationForDisplay") ?? tagValue(body, "pointCoordinates") ?? body;
  const lat = numberTag(source, "latitude");
  const lng = numberTag(source, "longitude");
  return lat !== null && lng !== null && inRegion(lat, lng) ? { lat, lng } : null;
};
const roadRef = (body: string) => {
  for (const tag of ["roadNumber", "roadName", "roadNameAtOrigin", "roadNameAtDestination"]) {
    const raw = tagValue(body, tag);
    if (!raw) continue;
    const match = /\b(?:A|N)\s?\d{1,3}\b/i.exec(stripTags(raw));
    if (match) return match[0].replace(/\s/g, "").toUpperCase();
  }
  return null;
};
const sourceName = (body: string) => {
  const source = tagValue(body, "source");
  const value = source ? tagValue(source, "value") : null;
  return value ? stripTags(value).slice(0, 80) : null;
};
const haversineM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};
const normalizeRoad = (value: unknown) => {
  const match = /^A\s*0*(\d{1,3})$/i.exec(String(value ?? "").trim());
  return match ? `A${Number(match[1])}` : null;
};

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

const title = (kind: TrafficKind, body: string) => {
  if (kind === "traffic") {
    const trafficType = stripTags(tagValue(body, "abnormalTrafficType") ?? "");
    if (trafficType === "stationaryTraffic") return "Stilstaand verkeer";
    if (trafficType === "queuingTraffic") return "File";
    if (trafficType === "slowTraffic") return "Langzaam verkeer";
    return "Afwijkend verkeersbeeld";
  }
  if (kind === "accident") return "Ongeval";
  if (kind === "obstruction") return "Obstakel / voertuig op de weg";
  if (kind === "closure") return "Afsluiting / rijstrookbeperking";
  if (kind === "works") return "Wegwerkzaamheden";
  return "Weers- of wegdekbelemmering";
};

const fresh = (kind: TrafficKind, timestamp: string | null) => {
  if (!timestamp) return kind === "works" || kind === "closure";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const ageMinutes = Math.max(0, (Date.now() - parsed) / 60000);
  return ageMinutes <= (kind === "works" || kind === "closure" ? 1440 : 180);
};

export function parseEvents(xml: string): TrafficEvent[] {
  const out: TrafficEvent[] = [];
  const regex = /<(?:(?:[A-Za-z0-9_-]+):)?situationRecord\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?situationRecord>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    const attrs = match[1];
    const body = match[2];
    const raw = attr(attrs, "xsi:type") ?? attr(attrs, "type") ?? "SituationRecord";
    const type = raw.split(":").pop() ?? raw;
    const kind = classify(type, body);
    const location = coords(body);
    if (!kind || !location) continue;
    const updatedRaw = tagValue(body, "situationRecordVersionTime") ?? tagValue(body, "situationRecordCreationTime");
    const updatedAt = updatedRaw ? stripTags(updatedRaw) : null;
    if (!fresh(kind, updatedAt)) continue;
    out.push({
      id: attr(attrs, "id") ?? `ndw-${out.length + 1}`,
      kind,
      title: title(kind, body),
      type,
      lat: location.lat,
      lng: location.lng,
      roadRef: roadRef(body),
      queueLengthMeters: numberTag(body, "queueLength"),
      source: sourceName(body) ?? "NDW",
      updatedAt,
    });
  }
  return out.slice(0, 500);
}

export function parseMatrix(xml: string): MatrixSignal[] {
  const map = new Map<string, MatrixSignal>();
  const regex = /<(?:(?:[A-Za-z0-9_-]+):)?event\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?event>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    const attrs = match[1];
    const body = match[2];
    const id = stripTags(tagValue(body, "sign_id") ?? attr(attrs, "sign_id") ?? "");
    if (!id) continue;
    const current = map.get(id) ?? {
      signId: id, road: null, carriageway: null, lane: null, km: null,
      display: "unknown" as const, speedLimit: null,
    };
    const road = tagValue(body, "road");
    const carriageway = tagValue(body, "carriageway");
    if (road) current.road = normalizeRoad(stripTags(road));
    if (carriageway) current.carriageway = stripTags(carriageway);
    current.lane = numberTag(body, "lane") ?? current.lane;
    current.km = numberTag(body, "km") ?? current.km;
    const speed = numberTag(body, "speedlimit");
    if (speed !== null) { current.display = "speed"; current.speedLimit = speed; }
    else if (hasTag(body, "lane_closed_ahead")) current.display = "lane_closed_ahead";
    else if (hasTag(body, "lane_closed")) current.display = "lane_closed";
    else if (hasTag(body, "lane_open")) current.display = "lane_open";
    else if (hasTag(body, "restriction_end")) current.display = "restriction_end";
    else if (hasTag(body, "blank")) current.display = "blank";
    map.set(id, current);
  }
  return [...map.values()].filter(item => TARGET_ROADS.has(item.road ?? ""));
}

export function parseRawMeasurementSites(xml: string): RawMeasurementSite[] {
  const out: RawMeasurementSite[] = [];
  const regex = /<(?:(?:[A-Za-z0-9_-]+):)?measurementSiteRecord\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?measurementSiteRecord>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    const id = attr(match[1], "id");
    const body = match[2];
    const location = coords(tagValue(body, "measurementSiteLocation") ?? body);
    if (!id || !location) continue;
    const name = stripTags(tagValue(body, "measurementSiteName") ?? "");
    const speedIndexes = new Set<number>();
    const flowIndexes = new Set<number>();
    const characteristics = /<(?:(?:[A-Za-z0-9_-]+):)?measurementSpecificCharacteristics\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?measurementSpecificCharacteristics>/gi;
    let characteristic: RegExpExecArray | null;
    while ((characteristic = characteristics.exec(body))) {
      const index = Number(attr(characteristic[1], "index"));
      if (!Number.isInteger(index)) continue;
      const inner = characteristic[2];
      const anyVehicle = /<(?:(?:[A-Za-z0-9_-]+):)?vehicleType\b[^>]*>\s*anyVehicle\s*<\//i.test(inner);
      if (!anyVehicle) continue;
      const type = stripTags(tagValue(inner, "specificMeasurementValueType") ?? "");
      if (type === "trafficSpeed") speedIndexes.add(index);
      if (type === "trafficFlow") flowIndexes.add(index);
    }
    if (speedIndexes.size || flowIndexes.size) out.push({ id, name, lat: location.lat, lng: location.lng, speedIndexes, flowIndexes });
  }
  return out;
}

export function parseRoadMetringPoints(payload: unknown): RoadMetringPoint[] {
  const features = (payload as { features?: Array<{ geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }> })?.features ?? [];
  const out: RoadMetringPoint[] = [];
  for (const feature of features) {
    const properties = feature.properties ?? {};
    const road = normalizeRoad(properties.a_n_nr);
    const coordinates = feature.geometry?.coordinates;
    if (!road || !TARGET_ROADS.has(road) || !Array.isArray(coordinates) || typeof coordinates[0] !== "number" || typeof coordinates[1] !== "number") continue;
    const lng = coordinates[0];
    const lat = coordinates[1];
    if (!inRegion(lat, lng)) continue;
    const direct = Number(String(properties.hectometer ?? "").replace(",", "."));
    const raw = Number(properties.hectomtrng);
    const km = Number.isFinite(direct) ? direct : Number.isFinite(raw) ? raw / 10 : NaN;
    if (!Number.isFinite(km)) continue;
    const rawWvk = Number(properties.wvk_id);
    out.push({
      road,
      km,
      lat,
      lng,
      direction: typeof properties.l_r === "string" ? properties.l_r : null,
      wvkId: Number.isFinite(rawWvk) ? rawWvk : null,
    });
  }
  return out;
}

export function mapMeasurementSites(raw: RawMeasurementSite[], points: RoadMetringPoint[]): MeasurementSite[] {
  const cell = .01;
  const key = (lat: number, lng: number) => `${Math.floor(lat / cell)}:${Math.floor(lng / cell)}`;
  const grid = new Map<string, RoadMetringPoint[]>();
  for (const point of points) {
    const id = key(point.lat, point.lng);
    const group = grid.get(id) ?? [];
    group.push(point);
    grid.set(id, group);
  }
  const out: MeasurementSite[] = [];
  for (const site of raw) {
    const explicit = /\b([AN])\s*0*(\d{1,3})\b/i.exec(site.name);
    const explicitRoad = explicit ? `${explicit[1].toUpperCase()}${Number(explicit[2])}` : null;
    if (explicitRoad?.startsWith("N")) continue;
    const iy = Math.floor(site.lat / cell);
    const ix = Math.floor(site.lng / cell);
    const candidates: Array<{ point: RoadMetringPoint; distance: number }> = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const point of grid.get(`${iy + dy}:${ix + dx}`) ?? []) {
        if (explicitRoad && point.road !== explicitRoad) continue;
        const distance = haversineM(site, point);
        if (distance <= 180) candidates.push({ point, distance });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    if (!best) continue;
    const competing = candidates.find(candidate => candidate.point.road !== best.point.road);
    if (competing && competing.distance <= 220 && competing.distance - best.distance < 45) continue;
    out.push({
      ...site,
      road: best.point.road,
      km: best.point.km,
      direction: best.point.direction,
      mappingDistanceMeters: Math.round(best.distance),
      wvkId: best.point.wvkId,
    });
  }
  return out;
}

function qualityForMeasuredValue(body: string, ageSeconds: number) {
  const supplierQuality = numberTag(body, "supplierCalculatedDataQuality");
  const inputValues = numberTag(body, "numberOfInputValuesUsed");
  const incompleteInputs = numberTag(body, "numberOfIncompleteInputs");
  let quality = supplierQuality === null ? 85 : clamp(supplierQuality, 0, 100);
  if (inputValues !== null && inputValues > 0 && incompleteInputs !== null) {
    const completeness = clamp(1 - incompleteInputs / inputValues, 0, 1);
    quality *= 0.65 + 0.35 * completeness;
  }
  if (ageSeconds > 120) quality *= 0.85;
  if (ageSeconds > 180) quality *= 0.7;
  return {
    qualityScore: Math.round(clamp(quality, 0, 100)),
    inputValues,
    incompleteInputs,
  };
}

export function parseTrafficSamples(xml: string, siteMap: Map<string, SiteConfig>): SiteTraffic[] {
  const out: SiteTraffic[] = [];
  const regex = /<(?:(?:[A-Za-z0-9_-]+):)?siteMeasurements\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?siteMeasurements>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    const body = match[1];
    const ref = /<(?:(?:[A-Za-z0-9_-]+):)?measurementSiteReference\b([^>]*)\/?\s*>/i.exec(body);
    const id = ref ? attr(ref[1], "id") : null;
    if (!id) continue;
    const config = siteMap.get(id);
    if (!config) continue;
    const measurementTime = tagValue(body, "measurementTimeDefault") ?? "";
    const measuredAt = stripTags(tagValue(measurementTime, "timeValue") ?? measurementTime);
    const measuredMs = Date.parse(measuredAt);
    if (!Number.isFinite(measuredMs)) continue;
    const ageSeconds = Math.abs(Date.now() - measuredMs) / 1000;
    if (ageSeconds > 240) continue;

    const speeds: Array<{ value: number; weight: number; quality: number; inputs: number | null; incomplete: number | null }> = [];
    const flows: Array<{ value: number; quality: number; inputs: number | null; incomplete: number | null }> = [];
    const measuredValue = /<(?:(?:[A-Za-z0-9_-]+):)?measuredValue\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?measuredValue>/gi;
    let valueMatch: RegExpExecArray | null;
    while ((valueMatch = measuredValue.exec(body))) {
      const index = Number(attr(valueMatch[1], "index"));
      const valueBody = valueMatch[2];
      if (!Number.isInteger(index) || /dataError[^>]*>\s*true\s*</i.test(valueBody)) continue;
      const quality = qualityForMeasuredValue(valueBody, ageSeconds);
      if (quality.qualityScore < 20) continue;
      if (config.speedIndexes.has(index)) {
        const speed = numberTag(valueBody, "speed");
        if (speed !== null && speed >= 0 && speed <= 200 && speed !== 256) {
          speeds.push({ value: speed, weight: 1, quality: quality.qualityScore, inputs: quality.inputValues, incomplete: quality.incompleteInputs });
        }
      }
      if (config.flowIndexes.has(index)) {
        const flow = numberTag(valueBody, "vehicleFlowRate");
        if (flow !== null && flow >= 0 && flow <= 10000) {
          flows.push({ value: flow, quality: quality.qualityScore, inputs: quality.inputValues, incomplete: quality.incompleteInputs });
        }
      }
    }

    let speed = median(speeds.map(item => item.value));
    const flow = flows.length ? flows.reduce((sum, item) => sum + item.value, 0) : null;
    if (speeds.length && flows.length === speeds.length) {
      const total = flows.reduce((sum, item) => sum + item.value, 0);
      if (total > 0) speed = speeds.reduce((sum, item, index) => sum + item.value * flows[index].value, 0) / total;
    }
    if (speed === null && flow === null) continue;

    const qualities = [...speeds.map(item => item.quality), ...flows.map(item => item.quality)];
    const inputs = [...speeds.map(item => item.inputs), ...flows.map(item => item.inputs)].filter((value): value is number => value !== null);
    const incomplete = [...speeds.map(item => item.incomplete), ...flows.map(item => item.incomplete)].filter((value): value is number => value !== null);
    out.push({
      siteId: id,
      measuredAt,
      speedKph: speed === null ? null : round1(speed),
      flowVehiclesPerHour: flow,
      qualityScore: qualities.length ? Math.round(median(qualities) ?? 0) : 75,
      inputValues: inputs.length ? Math.round(median(inputs) ?? 0) : null,
      incompleteInputs: incomplete.length ? Math.round(median(incomplete) ?? 0) : null,
    });
  }
  return out;
}

export const isActiveMatrix = (signal: MatrixSignal) => signal.display === "lane_closed" || signal.display === "lane_closed_ahead" || (signal.display === "speed" && (signal.speedLimit ?? 999) <= 90);

export function matrixSummary(signals: MatrixSignal[]): MatrixRoadSummary[] {
  const map = new Map<string, MatrixRoadSummary>();
  for (const signal of signals.filter(isActiveMatrix)) {
    if (!signal.road) continue;
    const current = map.get(signal.road) ?? { road: signal.road, active: 0, closures: 0, lowSpeed: 0 };
    current.active += 1;
    if (signal.display === "lane_closed" || signal.display === "lane_closed_ahead") current.closures += 1;
    if (signal.display === "speed" && (signal.speedLimit ?? 999) <= 70) current.lowSpeed += 1;
    map.set(signal.road, current);
  }
  return [...map.values()].sort((a, b) => b.closures - a.closures || b.lowSpeed - a.lowSpeed || b.active - a.active).slice(0, 30);
}
