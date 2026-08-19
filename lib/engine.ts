import type { StandbyLocation, TrafficEvent, WeatherSnapshot } from "@/lib/types";
import type { MatrixSignal, MeasurementSite, RoadMetringPoint, SiteTraffic } from "@/lib/ndw";
import { isActiveMatrix } from "@/lib/ndw";

export const SEGMENT_LENGTH_KM = 5;
export const MAX_EVENT_DISTANCE_KM = 4.5;
export const MAX_STANDBY_ROAD_DISTANCE_KM = 15;

export type CandidateLocation = StandbyLocation & {
  road: string;
  accessKm: number;
  direction: string | null;
  rayon: string | null;
};

export type ScopedMeasurementSite = MeasurementSite & {
  rayon: string;
  rangeFromKm: number;
  rangeToKm: number;
};

export type Segment = {
  rayon: string;
  road: string;
  kmFrom: number;
  kmTo: number;
  centerKm: number;
  lat: number;
  lng: number;
  sites: MeasurementSite[];
};

export const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

export function buildSegments(sites: ScopedMeasurementSite[]): Segment[] {
  const groups = new Map<string, ScopedMeasurementSite[]>();
  for (const site of sites) {
    const bucketFrom = Math.floor(site.km / SEGMENT_LENGTH_KM) * SEGMENT_LENGTH_KM;
    const key = `${site.rayon}:${site.road}:${bucketFrom}`;
    const group = groups.get(key) ?? [];
    group.push(site);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [rayon, road, rawFrom] = key.split(":");
    const bucketFrom = Number(rawFrom);
    const kmFrom = Math.max(bucketFrom, Math.min(...group.map(site => site.rangeFromKm)));
    const kmTo = Math.min(bucketFrom + SEGMENT_LENGTH_KM, Math.max(...group.map(site => site.rangeToKm)));
    return {
      rayon,
      road,
      kmFrom: Math.round(kmFrom * 10) / 10,
      kmTo: Math.round(kmTo * 10) / 10,
      centerKm: (kmFrom + kmTo) / 2,
      lat: group.reduce((sum, site) => sum + site.lat, 0) / group.length,
      lng: group.reduce((sum, site) => sum + site.lng, 0) / group.length,
      sites: group,
    };
  }).filter(segment => segment.kmTo > segment.kmFrom)
    .sort((a, b) => a.rayon.localeCompare(b.rayon, "nl", { numeric: true }) || a.road.localeCompare(b.road, "nl", { numeric: true }) || a.kmFrom - b.kmFrom);
}

const pressureFor = (speed: number | null, flow: number | null) => {
  let speedPoints = 0;
  let flowPoints = 0;
  if (speed !== null) {
    if (speed < 35) speedPoints = 38;
    else if (speed < 50) speedPoints = 32;
    else if (speed < 65) speedPoints = 25;
    else if (speed < 80) speedPoints = 17;
    else if (speed < 95) speedPoints = 8;
  }
  if (flow !== null) {
    if (flow >= 4500) flowPoints = 12;
    else if (flow >= 3200) flowPoints = 9;
    else if (flow >= 2200) flowPoints = 6;
    else if (flow >= 1400) flowPoints = 3;
  }
  return { score: Math.min(50, speedPoints + flowPoints), congestionIndex: Math.min(100, Math.round(speedPoints / 38 * 75 + flowPoints / 12 * 25)) };
};

export function sensorMetrics(seg: Segment, samples: Map<string, SiteTraffic>) {
  const rows = seg.sites.map(site => ({ site, sample: samples.get(site.id) }))
    .filter((x): x is { site: MeasurementSite; sample: SiteTraffic } => Boolean(x.sample));
  const speeds = rows.map(x => x.sample.speedKph).filter((x): x is number => x !== null && x > 0);
  const flows = rows.map(x => x.sample.flowVehiclesPerHour).filter((x): x is number => x !== null);
  const speed = median(speeds), flow = median(flows);
  const byDirection = new Map<string, SiteTraffic[]>();
  for (const row of rows) {
    const direction = row.site.direction ?? "unknown";
    const group = byDirection.get(direction) ?? [];
    group.push(row.sample);
    byDirection.set(direction, group);
  }
  const directionScores = [...byDirection.values()].map(group => {
    const ds = group.map(x => x.speedKph).filter((x): x is number => x !== null && x > 0);
    const df = group.map(x => x.flowVehiclesPerHour).filter((x): x is number => x !== null);
    return pressureFor(median(ds), median(df));
  });
  const base = directionScores.length ? directionScores.sort((a, b) => b.score - a.score)[0] : pressureFor(speed, flow);
  return { sensorCount: rows.length, directionCount: byDirection.size, averageSpeedKph: speed === null ? null : Math.round(speed * 10) / 10, flowVehiclesPerHour: flow === null ? null : Math.round(flow), congestionIndex: base.congestionIndex, score: base.score };
}

export function segmentMatrix(signals: MatrixSignal[], seg: Segment) {
  const relevant = signals.filter(signal => signal.road === seg.road && signal.km !== null && signal.km >= seg.kmFrom && signal.km < seg.kmTo && isActiveMatrix(signal));
  const clusters = new Map<string, { points: number; low: boolean; closed: boolean }>();
  for (const signal of relevant) {
    const key = `${signal.carriageway ?? "?"}:${Math.floor((signal.km ?? 0) * 10) / 10}`;
    let points = 0, low = false, closed = false;
    if (signal.display === "lane_closed") { points = 7; closed = true; }
    else if (signal.display === "lane_closed_ahead") { points = 5; closed = true; }
    else if ((signal.speedLimit ?? 999) <= 50) { points = 4; low = true; }
    else if ((signal.speedLimit ?? 999) <= 70) { points = 3; low = true; }
    else if ((signal.speedLimit ?? 999) <= 90) points = 1;
    const previous = clusters.get(key);
    if (!previous || points > previous.points) clusters.set(key, { points, low, closed });
  }
  const values = [...clusters.values()];
  return { score: Math.min(22, values.reduce((sum, x) => sum + x.points, 0)), clusters: values.length, lowSpeed: values.filter(x => x.low).length, closures: values.filter(x => x.closed).length };
}

const eventImpact = (event: TrafficEvent, distance: number) => {
  const base = event.kind === "accident" ? 11 : event.kind === "closure" ? 10 : event.kind === "obstruction" ? 6 : event.kind === "traffic" ? Math.min(10, 5 + Math.max(0, (event.queueLengthMeters ?? 0) / 1000)) : event.kind === "weather" ? 4 : 2;
  return base * Math.max(.2, 1 - distance / (MAX_EVENT_DISTANCE_KM + 1));
};

export function segmentEvents(seg: Segment, events: TrafficEvent[]) {
  const items = events.map(event => ({ event, distance: haversineKm(seg, event) }))
    .filter(x => x.distance <= MAX_EVENT_DISTANCE_KM && (!x.event.rayon || x.event.rayon === seg.rayon) && (x.event.roadRef === seg.road || x.event.roadRef === null));
  const points = items.map(x => eventImpact(x.event, x.distance) * (x.event.roadRef === seg.road ? 1 : .45)).sort((a, b) => b - a).slice(0, 3);
  return { items, score: Math.min(18, points.reduce((a, b) => a + b, 0)), accidents: items.filter(x => x.event.kind === "accident").length, obstructions: items.filter(x => x.event.kind === "obstruction" || x.event.kind === "closure").length };
}

export const weatherScore = (weather: WeatherSnapshot | null) => {
  if (!weather) return 0;
  let score = 0;
  if (weather.precipitation >= 2) score += 4; else if (weather.precipitation >= .2) score += 2;
  if (weather.windGusts >= 70) score += 3; else if (weather.windGusts >= 50) score += 1;
  if (weather.visibility > 0 && weather.visibility < 2000) score += 3; else if (weather.visibility > 0 && weather.visibility < 5000) score += 1;
  return Math.min(6, score);
};

const centroid = (geometry: { coordinates?: unknown } | undefined) => {
  const points: Array<[number, number]> = [];
  const walk = (value: unknown) => { if (!Array.isArray(value)) return; if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") { points.push([value[0], value[1]]); return; } value.forEach(walk); };
  walk(geometry?.coordinates);
  if (!points.length) return null;
  const lng = points.reduce((sum, p) => sum + p[0], 0) / points.length, lat = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  return lat >= 51.0 && lat <= 52.45 && lng >= 3.9 && lng <= 6.65 ? { lat, lng } : null;
};

const nearestRoadPoint = (location: { lat: number; lng: number }, points: RoadMetringPoint[], maxDistanceKm: number, road?: string | null) => {
  let best: { point: RoadMetringPoint; distance: number } | null = null;
  for (const point of points) {
    if (road && point.road !== road) continue;
    const distance = haversineKm(location, point);
    if (distance > maxDistanceKm) continue;
    if (!best || distance < best.distance) best = { point, distance };
  }
  return best;
};

const featureName = (props: Record<string, unknown>) => {
  for (const key of Object.keys(props).filter(key => /naam|name|object|verzorg/i.test(key))) {
    const value = props[key];
    if (typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 80) return value.trim();
  }
  return "RWS verzorgingsplaats";
};

export function parseRwsRestAreas(payload: unknown, points: RoadMetringPoint[]): CandidateLocation[] {
  const features = (payload as { features?: Array<{ geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }> })?.features ?? [];
  const out: CandidateLocation[] = [];
  for (const [index, feature] of features.entries()) {
    const location = centroid(feature.geometry);
    if (!location) continue;
    const nearest = nearestRoadPoint(location, points, 1.2);
    if (!nearest) continue;
    out.push({ id: `rws-${nearest.point.road}-${nearest.point.km.toFixed(1)}-${index}`, name: featureName(feature.properties ?? {}), address: `${nearest.point.road} km ${nearest.point.km.toFixed(1)} · officiële RWS-verzorgingsplaats`, lat: location.lat, lng: location.lng, kind: "service_area", source: "rws", verified: true, road: nearest.point.road, accessKm: nearest.point.km, direction: nearest.point.direction, rayon: null });
  }
  return out;
}

const normalizeRoad = (value: unknown) => { const match = /^A\s*0*(\d{1,3})$/i.exec(String(value ?? "").trim()); return match ? `A${Number(match[1])}` : null; };
type GeoFeature = { id?: string | number; geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> };

export function parseRwsVildCandidates(payload: unknown, points: RoadMetringPoint[], kind: StandbyLocation["kind"], layerLabel: string): CandidateLocation[] {
  const features = (payload as { features?: GeoFeature[] })?.features ?? [];
  const out: CandidateLocation[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {}, location = centroid(feature.geometry), road = normalizeRoad(props.roadnumber);
    if (!location || !road) continue;
    const nearest = nearestRoadPoint(location, points, 2, road);
    if (!nearest) continue;
    const rawName = [props.first_name, props.secnd_name].map(v => String(v ?? "").trim()).filter(v => v && v !== "-").join(" ");
    const name = rawName || `${layerLabel} ${road} km ${nearest.point.km.toFixed(1)}`;
    out.push({ id: `rws-vild-${layerLabel.toLowerCase().replace(/\W+/g, "-")}-${feature.id ?? props.objectid ?? out.length}`, name, address: `${road} km ${nearest.point.km.toFixed(1)} · Rijkswaterstaat ${layerLabel.toLowerCase()}`, lat: location.lat, lng: location.lng, kind, source: "rws", verified: true, road, accessKm: nearest.point.km, direction: nearest.point.direction, rayon: null });
  }
  return out;
}

type OsmElement = { id: number; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: Record<string, string> };
const osmKind = (tags: Record<string, string>): StandbyLocation["kind"] => { if (tags.carpool === "yes" || tags.park_ride === "yes") return "carpool"; if (tags.amenity === "fuel") return "fuel"; if (tags.amenity === "parking") return "parking"; if (tags.amenity === "restaurant" || tags.amenity === "fast_food") return "restaurant"; return "other"; };
const osmName = (tags: Record<string, string>, road: string, km: number) => tags.name || tags.brand || tags.operator || `${osmKind(tags) === "parking" ? "Parkeerplaats" : "Stand-byplek"} ${road} km ${km.toFixed(1)}`;

export function parseOsmCandidates(payload: unknown, points: RoadMetringPoint[]): CandidateLocation[] {
  const elements = (payload as { elements?: OsmElement[] })?.elements ?? [], out: CandidateLocation[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    if (tags.access === "private" || tags.access === "no" || tags.parking === "private") continue;
    const lat = element.lat ?? element.center?.lat, lng = element.lon ?? element.center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if (lat < 51.0 || lat > 52.45 || lng < 3.9 || lng > 6.65) continue;
    const nearest = nearestRoadPoint({ lat, lng }, points, 1.25);
    if (!nearest) continue;
    const kind = osmKind(tags);
    if (kind === "other") continue;
    const addressParts = [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]].filter(Boolean);
    out.push({ id: `osm-${element.id}`, name: osmName(tags, nearest.point.road, nearest.point.km), address: addressParts.length ? addressParts.join(" ") : `${nearest.point.road} km ${nearest.point.km.toFixed(1)} · OSM-kandidaat nabij snelweg`, lat, lng, kind, source: "osm", verified: false, road: nearest.point.road, accessKm: nearest.point.km, direction: nearest.point.direction, rayon: null });
  }
  const deduped = new Map<string, CandidateLocation>();
  for (const candidate of out) { const key = `${candidate.road}:${Math.round(candidate.accessKm * 5) / 5}:${candidate.name.toLowerCase()}`; if (!deduped.has(key)) deduped.set(key, candidate); }
  return [...deduped.values()];
}

const locationQuality = (location: CandidateLocation) => location.source === "rws" && location.kind === "service_area" ? 18 : location.source === "rws" && location.kind === "fuel" ? 17 : location.source === "rws" ? 16 : location.kind === "fuel" ? 10 : location.kind === "parking" ? 9 : location.kind === "carpool" ? 8 : location.kind === "restaurant" ? 7 : 3;

export function chooseDynamicStandby(seg: Segment, locations: CandidateLocation[], alreadyChosen: CandidateLocation[]) {
  const candidates = locations.filter(location => location.rayon === seg.rayon && location.road === seg.road && Math.abs(location.accessKm - seg.centerKm) <= MAX_STANDBY_ROAD_DISTANCE_KM)
    .map(location => {
      const roadDistance = Math.abs(location.accessKm - seg.centerKm), reused = alreadyChosen.some(chosen => chosen.id === location.id), overlap = alreadyChosen.some(chosen => chosen.road === location.road && Math.abs(chosen.accessKm - location.accessKm) < 10);
      return { location, roadDistance, rank: locationQuality(location) - roadDistance * 1.15 - (reused ? 18 : 0) - (overlap ? 5 : 0) };
    }).sort((a, b) => b.rank - a.rank || a.roadDistance - b.roadDistance);
  return candidates[0] ?? null;
}