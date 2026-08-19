import type { RoadDirection } from "@/lib/types";
import type { RoadMetringPoint } from "@/lib/ndw";
import { stripTags, tagValue } from "@/lib/ndw";
import { normalizeRoadDirection } from "@/lib/engine-v2";

export type TravelTimeSiteV2 = {
  id: string;
  name: string;
  road: string;
  direction: RoadDirection;
  kmFrom: number;
  kmTo: number;
  indexes: Set<number>;
  equipmentType: string | null;
  wvkIds: number[];
  mappingDistanceMeters: number;
  mappingQuality: number;
};

export type TravelTimeSampleV2 = {
  siteId: string;
  measuredAt: string;
  durationSeconds: number;
  averageSpeedKph: number;
  isFcd: boolean;
  availability: number | null;
  timeliness: number | null;
  coverage: number | null;
  inputValues: number | null;
  qualityScore: number;
};

export type TravelTimeMetricsV2 = {
  sampleCount: number;
  fcdCount: number;
  averageSpeedKph: number | null;
  score: number;
  congested: boolean;
  qualityScore: number | null;
  availability: number | null;
  timeliness: number | null;
  coverage: number | null;
  rejectedCount: number;
  mappingQuality: number | null;
};

type SegmentLike = {
  road: string;
  direction?: RoadDirection;
  kmFrom: number;
  kmTo: number;
};

type Point = { lat: number; lng: number };

const attr = (text: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]+)"`, "i").exec(text)?.[1] ?? null;
const numberTag = (xml: string, tag: string) => {
  const raw = tagValue(xml, tag);
  if (raw === null) return null;
  const value = Number(stripTags(raw).replace(",", "."));
  return Number.isFinite(value) ? value : null;
};
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const round1 = (value: number) => Math.round(value * 10) / 10;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mad = (values: number[], center: number) => median(values.map(value => Math.abs(value - center))) ?? 0;
const rad = (value: number) => value * Math.PI / 180;
const distanceKm = (a: Point, b: Point) => {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};
const normalizeRoad = (value: unknown) => {
  const match = /\bA\s*0*(\d{1,3})\b/i.exec(String(value ?? ""));
  return match ? `A${Number(match[1])}` : null;
};

function extractCoordinates(xml: string): Point[] {
  const out: Point[] = [];
  const regex = /<(?:(?:[A-Za-z0-9_-]+):)?(?:pointCoordinates|coordinatesForDisplay)\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?(?:pointCoordinates|coordinatesForDisplay)>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    const lat = numberTag(match[1], "latitude");
    const lng = numberTag(match[1], "longitude");
    if (lat !== null && lng !== null && lat >= 50 && lat <= 54 && lng >= 3 && lng <= 8) out.push({ lat, lng });
  }
  return out;
}

function recordRoad(record: string) {
  for (const tag of ["roadNumber", "roadName", "roadNameAtOrigin", "roadNameAtDestination", "measurementSiteName"]) {
    const raw = tagValue(record, tag);
    const road = raw ? normalizeRoad(stripTags(raw)) : null;
    if (road) return road;
  }
  return null;
}

function nearest(location: Point, points: RoadMetringPoint[], road: string, maxMeters = 600) {
  let best: { point: RoadMetringPoint; distanceMeters: number } | null = null;
  for (const point of points) {
    if (point.road !== road) continue;
    const distanceMeters = distanceKm(location, point) * 1000;
    if (distanceMeters > maxMeters) continue;
    if (!best || distanceMeters < best.distanceMeters) best = { point, distanceMeters };
  }
  return best;
}

function valueBlocks(record: string, tags: Array<"measuredValue" | "physicalQuantity">) {
  const out: Array<{ index: number; body: string }> = [];
  for (const tag of tags) {
    const regex = new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${tag}\\b([^>]*)>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${tag}>`, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(record))) {
      const index = Number(attr(match[1], "index"));
      if (Number.isInteger(index)) out.push({ index, body: match[2] });
    }
    if (out.length) break;
  }
  return out;
}

export function parseTravelTimeSiteV2(record: string, points: RoadMetringPoint[]): TravelTimeSiteV2 | null {
  if (!/travelTimeInformation/i.test(record)) return null;
  const open = /<(?:(?:[A-Za-z0-9_-]+):)?(?:measurementSiteRecord|measurementSite)\b([^>]*)>/i.exec(record);
  const id = open ? attr(open[1], "id") : null;
  if (!id) return null;
  const road = recordRoad(record);
  if (!road) return null;

  const indexes = new Set<number>();
  const characteristics = /<(?:(?:[A-Za-z0-9_-]+):)?measurementSpecificCharacteristics\b([^>]*)>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?measurementSpecificCharacteristics>/gi;
  let characteristic: RegExpExecArray | null;
  while ((characteristic = characteristics.exec(record))) {
    if (!/travelTimeInformation/i.test(characteristic[2])) continue;
    const index = Number(attr(characteristic[1], "index"));
    if (Number.isInteger(index)) indexes.add(index);
  }
  if (!indexes.size) return null;

  const coordinates = extractCoordinates(tagValue(record, "measurementSiteLocation") ?? record);
  if (!coordinates.length) return null;
  const mapped = coordinates.map(coordinate => nearest(coordinate, points, road)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (!mapped.length) return null;
  const maxDistance = Math.max(...mapped.map(item => item.distanceMeters));
  if (maxDistance > 600) return null;

  const knownDirections = [...new Set(mapped.map(item => normalizeRoadDirection(item.point.direction)).filter((value): value is Exclude<RoadDirection, null> => value !== null))];
  if (knownDirections.length > 1) return null;
  const direction = knownDirections[0] ?? null;
  const kms = mapped.map(item => item.point.km).filter(Number.isFinite);
  if (!kms.length) return null;
  let kmFrom = Math.min(...kms);
  let kmTo = Math.max(...kms);
  let geometryPenalty = 0;
  if (kmTo - kmFrom < 0.2) {
    // Some publications expose only a representative coordinate. Keep a small
    // local footprint, but deliberately lower mapping confidence rather than
    // pretending an exact long trajectory is known.
    const center = median(kms) ?? kmFrom;
    kmFrom = center - 0.25;
    kmTo = center + 0.25;
    geometryPenalty = 35;
  }
  if (kmTo - kmFrom > 80) return null;

  const snapQuality = clamp(100 - maxDistance / 6);
  const mappingQuality = Math.round(clamp(snapQuality - geometryPenalty));
  if (mappingQuality < 25) return null;
  const equipmentRaw = tagValue(record, "measurementEquipmentTypeUsed");
  const equipmentType = equipmentRaw ? stripTags(equipmentRaw).toLowerCase() : null;
  return {
    id,
    name: stripTags(tagValue(record, "measurementSiteName") ?? "") || `${road} reistijdtraject`,
    road,
    direction,
    kmFrom: round1(kmFrom),
    kmTo: round1(kmTo),
    indexes,
    equipmentType,
    wvkIds: [...new Set(mapped.map(item => item.point.wvkId).filter((value): value is number => typeof value === "number" && Number.isFinite(value)))],
    mappingDistanceMeters: Math.round(maxDistance),
    mappingQuality,
  };
}

export function parseTravelTimeSampleV2(record: string, sites: Map<string, TravelTimeSiteV2>): TravelTimeSampleV2 | null {
  const ref = /<(?:(?:[A-Za-z0-9_-]+):)?measurementSiteReference\b([^>]*)\/?\s*>/i.exec(record);
  const siteId = ref ? attr(ref[1], "id") : null;
  if (!siteId) return null;
  const site = sites.get(siteId);
  if (!site) return null;

  const timeRaw = tagValue(record, "measurementTimeDefault") ?? "";
  const measuredAt = stripTags(tagValue(timeRaw, "timeValue") ?? timeRaw);
  const measuredMs = Date.parse(measuredAt);
  if (!Number.isFinite(measuredMs)) return null;
  const ageSeconds = Math.abs(Date.now() - measuredMs) / 1000;
  if (ageSeconds > 300) return null;

  const durations: number[] = [];
  for (const block of valueBlocks(record, ["measuredValue", "physicalQuantity"])) {
    if (!site.indexes.has(block.index) || /dataError[^>]*>\s*true\s*</i.test(block.body)) continue;
    const duration = numberTag(block.body, "duration");
    if (duration !== null && duration > 0 && duration < 86400) durations.push(duration);
  }
  const durationSeconds = median(durations);
  if (durationSeconds === null) return null;
  const distance = Math.abs(site.kmTo - site.kmFrom);
  if (distance < 0.2) return null;
  const speed = distance / durationSeconds * 3600;
  if (!Number.isFinite(speed) || speed <= 0 || speed > 180) return null;

  const isFcd = /fcd|floating/i.test(site.equipmentType ?? "");
  const accuracy = numberTag(record, "accuracy");
  const supplierQuality = numberTag(record, "supplierCalculatedDataQuality");
  const inputValues = numberTag(record, "numberOfInputValuesUsed");
  let availability: number | null = null;
  let timeliness: number | null = null;
  let coverage: number | null = null;
  let qualityScore: number;

  if (isFcd) {
    // NDW explicitly defines these three fields differently for FCD travel time:
    // accuracy=availability, supplierCalculatedDataQuality=timeliness,
    // numberOfInputValuesUsed=coverage. They are percentages, not counts.
    availability = accuracy === null ? null : clamp(accuracy);
    timeliness = supplierQuality === null ? null : clamp(supplierQuality);
    coverage = inputValues === null ? null : clamp(inputValues);
    const dimensions = [availability, timeliness, coverage].filter((value): value is number => value !== null);
    if (dimensions.some(value => value < 20)) return null;
    qualityScore = dimensions.length
      ? Math.round((availability ?? median(dimensions) ?? 60) * .4 + (timeliness ?? median(dimensions) ?? 60) * .3 + (coverage ?? median(dimensions) ?? 60) * .3)
      : 55;
  } else {
    // For non-FCD measurements numberOfInputValuesUsed is an observation count,
    // not a percentage. Never fold it into a 0-100 quality value.
    const freshness = clamp(100 - Math.max(0, ageSeconds - 60) / 2.4);
    qualityScore = Math.round((supplierQuality === null ? 70 : clamp(supplierQuality)) * .7 + freshness * .3);
  }
  qualityScore = Math.round(clamp(qualityScore * (site.mappingQuality / 100)));
  if (qualityScore < 35) return null;

  return {
    siteId,
    measuredAt,
    durationSeconds: round1(durationSeconds),
    averageSpeedKph: round1(speed),
    isFcd,
    availability,
    timeliness,
    coverage,
    inputValues: isFcd ? null : inputValues,
    qualityScore,
  };
}

export function travelTimeMetricsV2(segment: SegmentLike, sites: TravelTimeSiteV2[], samples: Map<string, TravelTimeSampleV2>): TravelTimeMetricsV2 {
  const direction = segment.direction ?? null;
  const candidates = sites.filter(site => {
    if (site.road !== segment.road || site.kmFrom >= segment.kmTo || site.kmTo <= segment.kmFrom) return false;
    return !direction || !site.direction || site.direction === direction;
  }).map(site => ({ site, sample: samples.get(site.id) })).filter((item): item is { site: TravelTimeSiteV2; sample: TravelTimeSampleV2 } => Boolean(item.sample));

  const usable = candidates.filter(item => item.sample.qualityScore >= 45 && item.site.mappingQuality >= 40);
  const rawSpeeds = usable.map(item => item.sample.averageSpeedKph).filter(value => value > 0);
  const center = median(rawSpeeds);
  if (center === null) return { sampleCount: 0, fcdCount: 0, averageSpeedKph: null, score: 0, congested: false, qualityScore: null, availability: null, timeliness: null, coverage: null, rejectedCount: candidates.length, mappingQuality: null };
  const dispersion = mad(rawSpeeds, center);
  const threshold = Math.max(28, dispersion * 3.5);
  const filtered = usable.filter(item => rawSpeeds.length < 5 || Math.abs(item.sample.averageSpeedKph - center) <= threshold);
  const speed = median(filtered.map(item => item.sample.averageSpeedKph));
  if (speed === null) return { sampleCount: 0, fcdCount: 0, averageSpeedKph: null, score: 0, congested: false, qualityScore: null, availability: null, timeliness: null, coverage: null, rejectedCount: candidates.length, mappingQuality: null };

  let score = speed < 35 ? 24 : speed < 50 ? 20 : speed < 65 ? 15 : speed < 80 ? 10 : speed < 95 ? 5 : 0;
  const qualities = filtered.map(item => item.sample.qualityScore);
  const qualityScore = median(qualities) ?? 0;
  if (qualityScore < 55) score = Math.round(score * .6);
  else if (qualityScore < 70) score = Math.round(score * .8);

  const fcd = filtered.filter(item => item.sample.isFcd);
  const metric = (key: "availability" | "timeliness" | "coverage") => {
    const values = fcd.map(item => item.sample[key]).filter((value): value is number => value !== null);
    return values.length ? Math.round(median(values) ?? 0) : null;
  };
  return {
    sampleCount: filtered.length,
    fcdCount: fcd.length,
    averageSpeedKph: round1(speed),
    score,
    congested: score >= 5,
    qualityScore: Math.round(qualityScore),
    availability: metric("availability"),
    timeliness: metric("timeliness"),
    coverage: metric("coverage"),
    rejectedCount: candidates.length - filtered.length,
    mappingQuality: Math.round(median(filtered.map(item => item.site.mappingQuality)) ?? 0),
  };
}
