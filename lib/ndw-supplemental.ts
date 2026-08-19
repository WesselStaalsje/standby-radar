import type { RoadMetringPoint } from "@/lib/ndw";
import { stripTags, tagValue } from "@/lib/ndw";
import type { StandbyAdvice, TrafficEvent, TrafficKind } from "@/lib/types";

export type TravelTimeSite = {
  id: string;
  name: string;
  road: string;
  kmFrom: number;
  kmTo: number;
  lat: number;
  lng: number;
  indexes: Set<number>;
  equipmentType: string | null;
  mappingDistanceMeters: number;
};

export type TravelTimeSample = {
  siteId: string;
  measuredAt: string;
  durationSeconds: number;
  averageSpeedKph: number;
  quality: number | null;
};

export type DripSignal = {
  id: string;
  roads: string[];
  text: string;
  updatedAt: string | null;
  severity: "info" | "delay" | "closure";
};

export type TemporarySpeedRestriction = {
  id: string;
  road: string;
  kmFrom: number;
  kmTo: number;
  limitKph: number;
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: string | null;
};

type SegmentLike = Pick<StandbyAdvice, "road" | "kmFrom" | "kmTo" | "rayon">;
type Point = { lat: number; lng: number };

const attr = (text: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]+)"`, "i").exec(text)?.[1] ?? null;
const numberTag = (xml: string, tag: string) => {
  const raw = tagValue(xml, tag);
  if (raw === null) return null;
  const value = Number(stripTags(raw).replace(",", "."));
  return Number.isFinite(value) ? value : null;
};
const normalizeRoad = (value: unknown) => {
  const match = /\bA\s*0*(\d{1,3})\b/i.exec(String(value ?? ""));
  return match ? `A${Number(match[1])}` : null;
};
const round1 = (value: number) => Math.round(value * 10) / 10;
const rad = (value: number) => value * Math.PI / 180;
const distanceKm = (a: Point, b: Point) => {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function allRoadRefs(text: string) {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bA\s*0*(\d{1,3})\b/gi)) found.add(`A${Number(match[1])}`);
  return [...found];
}

function extractCoordinates(xml: string): Point[] {
  const out: Point[] = [];
  const pointRx = /<(?:(?:[A-Za-z0-9_-]+):)?pointCoordinates\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?pointCoordinates>/gi;
  let match: RegExpExecArray | null;
  while ((match = pointRx.exec(xml))) {
    const lat = numberTag(match[1], "latitude");
    const lng = numberTag(match[1], "longitude");
    if (lat !== null && lng !== null && lat >= 50 && lat <= 54 && lng >= 3 && lng <= 8) out.push({ lat, lng });
  }
  if (out.length) return out;

  const displayRx = /<(?:(?:[A-Za-z0-9_-]+):)?coordinatesForDisplay\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?coordinatesForDisplay>/gi;
  while ((match = displayRx.exec(xml))) {
    const lat = numberTag(match[1], "latitude");
    const lng = numberTag(match[1], "longitude");
    if (lat !== null && lng !== null && lat >= 50 && lat <= 54 && lng >= 3 && lng <= 8) out.push({ lat, lng });
  }
  return out;
}

function nearestRoadPoint(location: Point, points: RoadMetringPoint[], road?: string | null, maxDistanceKm = 2.5) {
  let best: { point: RoadMetringPoint; distance: number } | null = null;
  for (const point of points) {
    if (road && point.road !== road) continue;
    const distance = distanceKm(location, point);
    if (distance > maxDistanceKm) continue;
    if (!best || distance < best.distance) best = { point, distance };
  }
  return best;
}

function extractValidity(xml: string) {
  const startRaw = tagValue(xml, "overallStartTime") ?? tagValue(xml, "startOfPeriod");
  const endRaw = tagValue(xml, "overallEndTime") ?? tagValue(xml, "endOfPeriod");
  const startsAt = startRaw ? stripTags(startRaw) : null;
  const endsAt = endRaw ? stripTags(endRaw) : null;
  return { startsAt, endsAt };
}

function isActiveOrSoon(startsAt: string | null, endsAt: string | null, horizonHours: number) {
  const now = Date.now();
  const start = startsAt ? Date.parse(startsAt) : NaN;
  const end = endsAt ? Date.parse(endsAt) : NaN;
  if (Number.isFinite(end) && end < now - 5 * 60_000) return false;
  if (Number.isFinite(start) && start > now + horizonHours * 60 * 60_000) return false;
  return true;
}

function findRecordRoad(record: string, points: RoadMetringPoint[]) {
  for (const tag of ["roadNumber", "roadName", "roadNameAtOrigin", "roadNameAtDestination"]) {
    const value = tagValue(record, tag);
    const road = value ? normalizeRoad(stripTags(value)) : null;
    if (road) return road;
  }
  const name = stripTags(tagValue(record, "measurementSiteName") ?? tagValue(record, "description") ?? "");
  const explicit = normalizeRoad(name);
  if (explicit) return explicit;
  const coordinates = extractCoordinates(record);
  if (!coordinates.length) return null;
  return nearestRoadPoint(coordinates[0], points, null, 1.5)?.point.road ?? null;
}

export function parseTravelTimeSiteRecord(record: string, points: RoadMetringPoint[]): TravelTimeSite | null {
  if (!/travelTimeInformation/i.test(record)) return null;
  const open = /<(?:(?:[A-Za-z0-9_-]+):)?(?:measurementSiteRecord|measurementSite)\b([^>]*)>/i.exec(record);
  const id = open ? attr(open[1], "id") : null;
  if (!id) return null;

  const name = stripTags(tagValue(record, "measurementSiteName") ?? "");
  const road = findRecordRoad(record, points);
  if (!road) return null;

  const indexes = new Set<number>();
  const characteristicRx = /<(?:(?:[A-Za-z0-9_-]+):)?measurementSpecificCharacteristics\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?measurementSpecificCharacteristics>/gi;
  let characteristic: RegExpExecArray | null;
  while ((characteristic = characteristicRx.exec(record))) {
    if (!/travelTimeInformation/i.test(characteristic[2])) continue;
    const index = Number(attr(characteristic[1], "index"));
    if (Number.isInteger(index)) indexes.add(index);
  }
  if (!indexes.size) return null;

  const coordinates = extractCoordinates(tagValue(record, "measurementSiteLocation") ?? record);
  if (!coordinates.length) return null;
  const mapped = coordinates
    .map(coordinate => nearestRoadPoint(coordinate, points, road, 3))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (!mapped.length) return null;

  const kms = mapped.map(item => item.point.km).filter(Number.isFinite);
  let kmFrom = Math.min(...kms);
  let kmTo = Math.max(...kms);
  if (!Number.isFinite(kmFrom) || !Number.isFinite(kmTo)) return null;
  if (kmTo - kmFrom < 0.2) {
    const center = median(kms) ?? kmFrom;
    kmFrom = center - 0.5;
    kmTo = center + 0.5;
  }
  if (kmTo - kmFrom > 100) return null;

  const centerKm = (kmFrom + kmTo) / 2;
  const representative = points
    .filter(point => point.road === road)
    .sort((a, b) => Math.abs(a.km - centerKm) - Math.abs(b.km - centerKm))[0];
  if (!representative) return null;

  const equipmentTypeRaw = tagValue(record, "measurementEquipmentTypeUsed");
  const equipmentType = equipmentTypeRaw ? stripTags(equipmentTypeRaw).toLowerCase() : null;
  const mappingDistanceMeters = Math.round(Math.max(...mapped.map(item => item.distance)) * 1000);

  return {
    id,
    name: name || `${road} reistijdtraject`,
    road,
    kmFrom: round1(kmFrom),
    kmTo: round1(kmTo),
    lat: representative.lat,
    lng: representative.lng,
    indexes,
    equipmentType,
    mappingDistanceMeters,
  };
}

export function parseTravelTimeSample(record: string, siteMap: Map<string, TravelTimeSite>): TravelTimeSample | null {
  const ref = /<(?:(?:[A-Za-z0-9_-]+):)?measurementSiteReference\b([^>]*)\/?\s*>/i.exec(record);
  const siteId = ref ? attr(ref[1], "id") : null;
  if (!siteId) return null;
  const site = siteMap.get(siteId);
  if (!site) return null;

  const timeRaw = tagValue(record, "measurementTimeDefault") ?? "";
  const measuredAt = stripTags(tagValue(timeRaw, "timeValue") ?? timeRaw);
  const measuredMs = Date.parse(measuredAt);
  if (!Number.isFinite(measuredMs) || Math.abs(Date.now() - measuredMs) > 5 * 60_000) return null;

  const durations: number[] = [];
  const collect = (tagName: "measuredValue" | "physicalQuantity") => {
    const rx = new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${tagName}>`, "gi");
    let match: RegExpExecArray | null;
    while ((match = rx.exec(record))) {
      const index = Number(attr(match[1], "index"));
      if (!site.indexes.has(index) || /dataError[^>]*>\s*true\s*</i.test(match[2])) continue;
      const duration = numberTag(match[2], "duration");
      if (duration !== null && duration > 0 && duration < 24 * 60 * 60) durations.push(duration);
    }
  };
  collect("measuredValue");
  if (!durations.length) collect("physicalQuantity");
  const durationSeconds = median(durations);
  if (durationSeconds === null) return null;

  const distance = Math.abs(site.kmTo - site.kmFrom);
  if (distance < 0.2) return null;
  const averageSpeedKph = distance / durationSeconds * 3600;
  if (!Number.isFinite(averageSpeedKph) || averageSpeedKph <= 0 || averageSpeedKph > 180) return null;

  const qualityCandidates = [
    numberTag(record, "accuracy"),
    numberTag(record, "supplierCalculatedDataQuality"),
    numberTag(record, "numberOfInputValuesUsed"),
  ].filter((value): value is number => value !== null && Number.isFinite(value));
  const quality = qualityCandidates.length ? Math.max(...qualityCandidates.map(value => Math.min(100, value))) : null;

  return {
    siteId,
    measuredAt,
    durationSeconds: round1(durationSeconds),
    averageSpeedKph: round1(averageSpeedKph),
    quality,
  };
}

export function travelTimeMetrics(segment: SegmentLike, sites: TravelTimeSite[], samples: Map<string, TravelTimeSample>) {
  const relevant = sites
    .filter(site => site.road === segment.road && site.kmFrom < segment.kmTo && site.kmTo > segment.kmFrom)
    .map(site => ({ site, sample: samples.get(site.id) }))
    .filter((item): item is { site: TravelTimeSite; sample: TravelTimeSample } => Boolean(item.sample));
  const speeds = relevant.map(item => item.sample.averageSpeedKph).filter(speed => speed > 0);
  const averageSpeedKph = median(speeds);
  if (averageSpeedKph === null) return { sampleCount: 0, fcdCount: 0, averageSpeedKph: null, score: 0, congested: false, quality: null };

  let score = 0;
  if (averageSpeedKph < 35) score = 24;
  else if (averageSpeedKph < 50) score = 20;
  else if (averageSpeedKph < 65) score = 15;
  else if (averageSpeedKph < 80) score = 10;
  else if (averageSpeedKph < 95) score = 5;

  const qualities = relevant.map(item => item.sample.quality).filter((value): value is number => value !== null);
  const quality = median(qualities);
  if (quality !== null && quality < 40) score = Math.round(score * 0.5);
  else if (quality !== null && quality < 60) score = Math.round(score * 0.75);

  return {
    sampleCount: relevant.length,
    fcdCount: relevant.filter(item => /fcd|floating/i.test(item.site.equipmentType ?? "")).length,
    averageSpeedKph: round1(averageSpeedKph),
    score,
    congested: score >= 5,
    quality: quality === null ? null : Math.round(quality),
  };
}

export function parseDripSignals(xml: string): DripSignal[] {
  const out: DripSignal[] = [];
  const containerRx = /<(?:(?:[A-Za-z0-9_-]+):)?(?:vmsControllerStatus|vmsUnit)\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?(?:vmsControllerStatus|vmsUnit)>/gi;
  let container: RegExpExecArray | null;
  while ((container = containerRx.exec(xml))) {
    const body = container[2];
    const lines: string[] = [];
    const lineRx = /<(?:(?:[A-Za-z0-9_-]+):)?textLine\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?textLine>/gi;
    let line: RegExpExecArray | null;
    while ((line = lineRx.exec(body))) {
      const text = stripTags(line[1]);
      if (text && !lines.includes(text)) lines.push(text);
    }
    const text = lines.join(" · ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const roads = allRoadRefs(text);
    if (!roads.length) continue;
    const lower = text.toLowerCase();
    const severity: DripSignal["severity"] = /\bdicht\b|afgesloten|stremming|road closed|rijbaan dicht|tunnel dicht/.test(lower)
      ? "closure"
      : /file|vertraging|ongeval|incident|langzaam|omleiding|\+\s*\d+\s*min/.test(lower) ? "delay" : "info";
    if (severity === "info") continue;
    const timeRaw = tagValue(body, "timeLastSet") ?? tagValue(body, "publicationTime");
    const updatedAt = timeRaw ? stripTags(timeRaw) : null;
    if (updatedAt) {
      const timestamp = Date.parse(updatedAt);
      if (Number.isFinite(timestamp) && Date.now() - timestamp > 6 * 60 * 60_000) continue;
    }
    out.push({
      id: attr(container[1], "id") ?? `drip-${out.length + 1}`,
      roads,
      text: text.slice(0, 240),
      updatedAt,
      severity,
    });
  }
  return out.slice(0, 500);
}

export function dripMetrics(segment: SegmentLike, signals: DripSignal[], independentPressure: boolean) {
  const relevant = signals.filter(signal => signal.roads.includes(segment.road));
  const warning = relevant.filter(signal => signal.severity !== "info");
  const score = independentPressure && warning.length ? Math.min(3, warning.some(signal => signal.severity === "closure") ? 3 : 2) : 0;
  return { count: warning.length, score, strongest: warning[0] ?? null };
}

export function parseTemporarySpeedRestrictions(xml: string, points: RoadMetringPoint[]): TemporarySpeedRestriction[] {
  const out: TemporarySpeedRestriction[] = [];
  const rx = /<(?:(?:[A-Za-z0-9_-]+):)?situationRecord\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?situationRecord>/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(xml))) {
    const record = match[2];
    const limit = numberTag(record, "temporarySpeedLimit");
    if (limit === null || limit <= 0 || limit > 130) continue;
    const managementType = stripTags(tagValue(record, "speedManagementType") ?? "");
    if (managementType && managementType !== "speedRestrictionInOperation") continue;
    const { startsAt, endsAt } = extractValidity(record);
    if (!isActiveOrSoon(startsAt, endsAt, 1)) continue;
    const road = findRecordRoad(record, points);
    if (!road) continue;
    const coordinates = extractCoordinates(record);
    const mapped = coordinates
      .map(coordinate => nearestRoadPoint(coordinate, points, road, 2.5))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!mapped.length) continue;
    const kms = mapped.map(item => item.point.km);
    let kmFrom = Math.min(...kms);
    let kmTo = Math.max(...kms);
    if (kmTo - kmFrom < 0.2) {
      const center = median(kms) ?? kmFrom;
      kmFrom = center - 0.75;
      kmTo = center + 0.75;
    }
    const updatedRaw = tagValue(record, "situationRecordVersionTime") ?? tagValue(record, "situationRecordCreationTime");
    out.push({
      id: attr(match[1], "id") ?? `temp-speed-${out.length + 1}`,
      road,
      kmFrom: round1(kmFrom),
      kmTo: round1(kmTo),
      limitKph: Math.round(limit),
      startsAt,
      endsAt,
      updatedAt: updatedRaw ? stripTags(updatedRaw) : null,
    });
  }
  return out;
}

export function temporaryLimitForSegment(segment: SegmentLike, restrictions: TemporarySpeedRestriction[]) {
  const relevant = restrictions.filter(item => item.road === segment.road && item.kmFrom < segment.kmTo && item.kmTo > segment.kmFrom);
  return relevant.length ? Math.min(...relevant.map(item => item.limitKph)) : null;
}

export function adjustedSensorScoreForTemporaryLimit(advice: StandbyAdvice, limitKph: number | null) {
  if (!limitKph || advice.averageSpeedKph === null || advice.sensorCount === 0) return { scoreReduction: 0, congestionReduction: 0 };
  const ratio = advice.averageSpeedKph / limitKph;
  if (ratio >= 0.9) return { scoreReduction: Math.min(8, advice.score), congestionReduction: Math.min(20, advice.congestionIndex) };
  if (ratio >= 0.78) return { scoreReduction: Math.min(4, advice.score), congestionReduction: Math.min(10, advice.congestionIndex) };
  return { scoreReduction: 0, congestionReduction: 0 };
}

function classifyPlanned(type: string, body: string, sourceLabel: string): { kind: TrafficKind; title: string } | null {
  const raw = type.toLowerCase();
  const lower = body.toLowerCase();
  if (/bridgeswinginoperation/i.test(body)) return { kind: "closure", title: "Brugopening met verkeersstremming" };
  if (raw.includes("constructionworks") || raw.includes("maintenanceworks") || raw.includes("roadworks")) return { kind: "works", title: "Geplande wegwerkzaamheden" };
  if (raw.includes("publicevent") || raw.includes("event")) return { kind: "works", title: "Evenement met verkeershinder" };
  if (raw.includes("roadorcarriagewayorlanemanagement")) {
    if (/closed|closure|blocked|roadclosed|carriagewayclosed|lanesclosed/.test(lower)) return { kind: "closure", title: "Geplande afsluiting / rijstrookbeperking" };
    return { kind: "works", title: "Geplande verkeersmaatregel" };
  }
  if (raw.includes("generalnetworkmanagement")) {
    if (/bridgeswinginoperation/.test(lower)) return { kind: "closure", title: "Brugopening met verkeersstremming" };
    if (/temporarytrafficlights|rerout|trafficcontrollers/.test(lower)) return { kind: "works", title: "Geplande verkeersmaatregel" };
  }
  if (sourceLabel.toLowerCase().includes("brug") && /bridge/i.test(body)) return { kind: "closure", title: "Brugopening met verkeersstremming" };
  return null;
}

export function parsePlannedSituationRecord(recordXml: string, points: RoadMetringPoint[], sourceLabel: string, horizonHours = 6): TrafficEvent | null {
  const open = /<(?:(?:[A-Za-z0-9_-]+):)?situationRecord\b([^>]*)>/i.exec(recordXml);
  const attributes = open?.[1] ?? "";
  const rawType = attr(attributes, "xsi:type") ?? attr(attributes, "type") ?? "SituationRecord";
  const type = rawType.split(":").pop() ?? rawType;
  const classification = classifyPlanned(type, recordXml, sourceLabel);
  if (!classification) return null;

  const { startsAt, endsAt } = extractValidity(recordXml);
  if (!isActiveOrSoon(startsAt, endsAt, horizonHours)) return null;
  const startMs = startsAt ? Date.parse(startsAt) : NaN;
  const planned = Number.isFinite(startMs) ? startMs > Date.now() + 2 * 60_000 : false;

  const road = findRecordRoad(recordXml, points);
  const coordinates = extractCoordinates(recordXml);
  let mapped = coordinates.length ? nearestRoadPoint(coordinates[0], points, road, 2.5) : null;
  if (!mapped && coordinates.length) mapped = nearestRoadPoint(coordinates[0], points, null, 1.5);
  if (!mapped) return null;

  const updatedRaw = tagValue(recordXml, "situationRecordVersionTime") ?? tagValue(recordXml, "situationRecordCreationTime");
  const queueLengthMeters = numberTag(recordXml, "queueLength");
  const id = attr(attributes, "id") ?? `${sourceLabel.toLowerCase().replace(/\W+/g, "-")}-${mapped.point.road}-${mapped.point.km}-${classification.kind}`;

  return {
    id,
    kind: classification.kind,
    title: planned ? `${classification.title} (binnen ${horizonHours} uur)` : classification.title,
    type,
    lat: coordinates[0]?.lat ?? mapped.point.lat,
    lng: coordinates[0]?.lng ?? mapped.point.lng,
    roadRef: road ?? mapped.point.road,
    roadKm: mapped.point.km,
    queueLengthMeters,
    source: sourceLabel,
    updatedAt: updatedRaw ? stripTags(updatedRaw) : null,
    startsAt,
    endsAt,
    planned,
  };
}

export function mapEventToRoad(event: TrafficEvent, points: RoadMetringPoint[]) {
  const mapped = nearestRoadPoint(event, points, event.roadRef, 1.8) ?? nearestRoadPoint(event, points, null, 1.2);
  if (!mapped) return null;
  return { ...event, roadRef: event.roadRef ?? mapped.point.road, roadKm: mapped.point.km };
}

export function scopeEventToAdvice(event: TrafficEvent, advice: StandbyAdvice[]) {
  if (!event.roadRef) return null;
  const roadKm = event.roadKm;
  const matches = advice.filter(item => item.road === event.roadRef);
  if (!matches.length) return null;
  if (roadKm !== null && roadKm !== undefined) {
    const exact = matches.find(item => roadKm >= item.kmFrom - 0.4 && roadKm <= item.kmTo + 0.4);
    if (exact) return { ...event, rayon: exact.rayon };
  }
  const nearest = matches
    .map(item => ({ item, distance: distanceKm(event, item.standby) }))
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest && nearest.distance <= 5 ? { ...event, rayon: nearest.item.rayon } : null;
}

export function mergeUniqueEvents(groups: TrafficEvent[][]) {
  const out: TrafficEvent[] = [];
  for (const group of groups) {
    for (const event of group) {
      const duplicate = out.some(existing => {
        if (existing.id === event.id) return true;
        if (existing.roadRef && event.roadRef && existing.roadRef !== event.roadRef) return false;
        const kindFamilyMatch = existing.kind === event.kind || ([existing.kind, event.kind].every(kind => kind === "closure" || kind === "obstruction"));
        return kindFamilyMatch && distanceKm(existing, event) <= 0.55;
      });
      if (!duplicate) out.push(event);
    }
  }
  return out.slice(0, 800);
}

export function eventOverlap(segment: SegmentLike, events: TrafficEvent[]) {
  return events.filter(event => {
    if (event.roadRef !== segment.road) return false;
    if (event.rayon && event.rayon !== segment.rayon) return false;
    if (event.roadKm !== null && event.roadKm !== undefined) return event.roadKm >= segment.kmFrom - 0.5 && event.roadKm <= segment.kmTo + 0.5;
    return true;
  });
}

export function plannedMetrics(segment: SegmentLike, events: TrafficEvent[]) {
  const relevant = eventOverlap(segment, events).filter(event => event.planned);
  let score = 0;
  const now = Date.now();
  for (const event of relevant) {
    const start = event.startsAt ? Date.parse(event.startsAt) : NaN;
    if (!Number.isFinite(start)) continue;
    const minutes = Math.max(0, (start - now) / 60_000);
    let points = 0;
    if (minutes <= 30) points = event.kind === "closure" ? 5 : 3;
    else if (minutes <= 120) points = event.kind === "closure" ? 3 : 2;
    else if (minutes <= 360) points = 1;
    score += points;
  }
  return { count: relevant.length, score: Math.min(6, score), items: relevant };
}

export function hasMatchingEvent(segment: SegmentLike, events: TrafficEvent[]) {
  return eventOverlap(segment, events).length > 0;
}

export function isTrafficPressure(advice: StandbyAdvice) {
  return advice.congestionIndex >= 25 || advice.matrixClusters > 0 || advice.localEvents > 0;
}
