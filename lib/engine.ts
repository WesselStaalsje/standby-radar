import type { RoadDirection, StandbyLocation, TrafficEvent, WeatherSnapshot } from "@/lib/types";
import type { MatrixSignal, MeasurementSite, RoadMetringPoint, SiteTraffic } from "@/lib/ndw";
import { isActiveMatrix } from "@/lib/ndw";

export const SEGMENT_LENGTH_KM = 5;
export const MAX_EVENT_DISTANCE_KM = 4.5;
export const MAX_STANDBY_ROAD_DISTANCE_KM = 15;

export const normalizeRoadDirection = (value: unknown): RoadDirection => {
  const text = String(value ?? "").trim().toLowerCase();
  if (["li", "l", "links", "left"].includes(text)) return "Li";
  if (["re", "r", "rechts", "right"].includes(text)) return "Re";
  return null;
};

export type CandidateLocation = StandbyLocation & {
  road: string;
  accessKm: number;
  direction: RoadDirection;
  rayon: string | null;
  wvkId?: number | null;
};

export type ScopedMeasurementSite = MeasurementSite & {
  rayon: string;
  rangeFromKm: number;
  rangeToKm: number;
};

export type Segment = {
  rayon: string;
  road: string;
  direction: RoadDirection;
  kmFrom: number;
  kmTo: number;
  centerKm: number;
  lat: number;
  lng: number;
  wvkIds: number[];
  sites: MeasurementSite[];
};

export const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const mode = (values: number[]) => {
  if (!values.length) return null;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
};

const mad = (values: number[], center: number) => median(values.map(value => Math.abs(value - center))) ?? 0;

export const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

const pointWvkId = (point: RoadMetringPoint) => {
  const value = (point as RoadMetringPoint & { wvkId?: number | null }).wvkId;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export function buildSegments(sites: ScopedMeasurementSite[]): Segment[] {
  const groups = new Map<string, ScopedMeasurementSite[]>();
  for (const site of sites) {
    const direction = normalizeRoadDirection(site.direction);
    const bucketFrom = Math.floor(site.km / SEGMENT_LENGTH_KM) * SEGMENT_LENGTH_KM;
    const key = `${site.rayon}:${site.road}:${direction ?? "B"}:${bucketFrom}`;
    const group = groups.get(key) ?? [];
    group.push(site);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [rayon, road, rawDirection, rawFrom] = key.split(":");
    const direction = rawDirection === "B" ? null : normalizeRoadDirection(rawDirection);
    const bucketFrom = Number(rawFrom);
    const kmFrom = Math.max(bucketFrom, Math.min(...group.map(site => site.rangeFromKm)));
    const kmTo = Math.min(bucketFrom + SEGMENT_LENGTH_KM, Math.max(...group.map(site => site.rangeToKm)));
    const wvkIds = [...new Set(group.map(site => (site as MeasurementSite & { wvkId?: number | null }).wvkId).filter((value): value is number => typeof value === "number" && Number.isFinite(value)))];
    return {
      rayon,
      road,
      direction,
      kmFrom: Math.round(kmFrom * 10) / 10,
      kmTo: Math.round(kmTo * 10) / 10,
      centerKm: (kmFrom + kmTo) / 2,
      lat: group.reduce((sum, site) => sum + site.lat, 0) / group.length,
      lng: group.reduce((sum, site) => sum + site.lng, 0) / group.length,
      wvkIds,
      sites: group,
    };
  }).filter(segment => segment.kmTo > segment.kmFrom)
    .sort((a, b) => a.rayon.localeCompare(b.rayon, "nl", { numeric: true }) || a.road.localeCompare(b.road, "nl", { numeric: true }) || (a.direction ?? "").localeCompare(b.direction ?? "") || a.kmFrom - b.kmFrom);
}

const pressureFor = (speed: number | null, flow: number | null, flowPerLane: number | null) => {
  let speedPoints = 0;
  let flowPoints = 0;
  if (speed !== null) {
    if (speed < 35) speedPoints = 38;
    else if (speed < 50) speedPoints = 32;
    else if (speed < 65) speedPoints = 25;
    else if (speed < 80) speedPoints = 17;
    else if (speed < 95) speedPoints = 8;
  }
  if (flowPerLane !== null) {
    if (flowPerLane >= 1800) flowPoints = 12;
    else if (flowPerLane >= 1500) flowPoints = 9;
    else if (flowPerLane >= 1100) flowPoints = 6;
    else if (flowPerLane >= 700) flowPoints = 3;
  } else if (flow !== null) {
    if (flow >= 4500) flowPoints = 12;
    else if (flow >= 3200) flowPoints = 9;
    else if (flow >= 2200) flowPoints = 6;
    else if (flow >= 1400) flowPoints = 3;
  }
  return {
    score: Math.min(50, speedPoints + flowPoints),
    congestionIndex: Math.min(100, Math.round(speedPoints / 38 * 75 + flowPoints / 12 * 25)),
  };
};

type QualityTraffic = SiteTraffic & {
  qualityScore?: number | null;
  inputValues?: number | null;
  incompleteInputs?: number | null;
};

export function sensorMetrics(seg: Segment, samples: Map<string, SiteTraffic>, closedLaneCount = 0) {
  const directionalSites = seg.sites.filter(site => {
    const direction = normalizeRoadDirection(site.direction);
    return !seg.direction || !direction || direction === seg.direction;
  });
  const allRows = directionalSites.map(site => ({ site, sample: samples.get(site.id) as QualityTraffic | undefined }))
    .filter((x): x is { site: MeasurementSite; sample: QualityTraffic } => Boolean(x.sample));

  const qualityRows = allRows.filter(row => (row.sample.qualityScore ?? 75) >= 35);
  const rawSpeeds = qualityRows.map(row => row.sample.speedKph).filter((value): value is number => value !== null && value > 0);
  const centerSpeed = median(rawSpeeds);
  const speedMad = centerSpeed === null ? 0 : mad(rawSpeeds, centerSpeed);
  const speedThreshold = Math.max(22, speedMad * 3.5);

  const rows = qualityRows.filter(row => {
    if (centerSpeed === null || row.sample.speedKph === null || rawSpeeds.length < 4) return true;
    return Math.abs(row.sample.speedKph - centerSpeed) <= speedThreshold;
  });

  const speeds = rows.map(row => row.sample.speedKph).filter((value): value is number => value !== null && value > 0);
  const rawFlows = rows.map(row => row.sample.flowVehiclesPerHour).filter((value): value is number => value !== null && value >= 0);
  const flowCenter = median(rawFlows);
  const flows = rawFlows.length >= 4 && flowCenter !== null && flowCenter > 0
    ? rawFlows.filter(value => value <= Math.max(flowCenter * 3.2, flowCenter + 2400))
    : rawFlows;
  const speed = median(speeds);
  const flow = median(flows);

  const laneCandidates = rows.map(row => {
    const speedChannels = row.site.speedIndexes?.size ?? 0;
    const flowChannels = row.site.flowIndexes?.size ?? 0;
    const channels = Math.min(speedChannels || flowChannels, flowChannels || speedChannels);
    return channels >= 1 && channels <= 6 ? channels : null;
  }).filter((value): value is number => value !== null);
  const modalLanes = mode(laneCandidates);
  const laneSupport = modalLanes === null ? 0 : laneCandidates.filter(value => value === modalLanes).length;
  const laneCount = modalLanes !== null && (modalLanes === 1 || laneSupport >= 2) ? modalLanes : null;
  const effectiveLaneCount = laneCount === null ? null : Math.max(1, laneCount - Math.max(0, closedLaneCount));
  const flowPerLane = flow !== null && effectiveLaneCount ? flow / effectiveLaneCount : null;
  const base = pressureFor(speed, flow, flowPerLane);
  const qualities = rows.map(row => row.sample.qualityScore).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const qualityScore = median(qualities);

  return {
    sensorCount: rows.length,
    rejectedSensorCount: Math.max(0, allRows.length - rows.length),
    directionCount: seg.direction ? 1 : new Set(rows.map(row => normalizeRoadDirection(row.site.direction) ?? "unknown")).size,
    averageSpeedKph: speed === null ? null : Math.round(speed * 10) / 10,
    flowVehiclesPerHour: flow === null ? null : Math.round(flow),
    flowPerLane: flowPerLane === null ? null : Math.round(flowPerLane),
    laneCount,
    effectiveLaneCount,
    qualityScore: qualityScore === null ? (rows.length ? 75 : null) : Math.round(qualityScore),
    congestionIndex: base.congestionIndex,
    score: base.score,
  };
}

export function segmentMatrix(signals: MatrixSignal[], seg: Segment) {
  const relevant = signals.filter(signal => {
    if (signal.road !== seg.road || signal.km === null || signal.km < seg.kmFrom || signal.km >= seg.kmTo || !isActiveMatrix(signal)) return false;
    const signalDirection = normalizeRoadDirection(signal.carriageway);
    return !seg.direction || !signalDirection || signalDirection === seg.direction;
  });
  const clusters = new Map<string, { points: number; low: boolean; closed: boolean; lane: number | null }>();
  let unknownDirection = 0;
  for (const signal of relevant) {
    const signalDirection = normalizeRoadDirection(signal.carriageway);
    if (!signalDirection) unknownDirection += 1;
    const key = `${signalDirection ?? "?"}:${Math.floor((signal.km ?? 0) * 10) / 10}:${signal.lane ?? "?"}`;
    let points = 0, low = false, closed = false;
    if (signal.display === "lane_closed") { points = 7; closed = true; }
    else if (signal.display === "lane_closed_ahead") { points = 5; closed = true; }
    else if ((signal.speedLimit ?? 999) <= 50) { points = 4; low = true; }
    else if ((signal.speedLimit ?? 999) <= 70) { points = 3; low = true; }
    else if ((signal.speedLimit ?? 999) <= 90) points = 1;
    const previous = clusters.get(key);
    if (!previous || points > previous.points) clusters.set(key, { points, low, closed, lane: signal.lane });
  }
  const values = [...clusters.values()];
  const closedLaneCount = new Set(values.filter(value => value.closed && value.lane !== null).map(value => value.lane)).size;
  return {
    score: Math.min(22, values.reduce((sum, value) => sum + value.points, 0)),
    clusters: values.length,
    lowSpeed: values.filter(value => value.low).length,
    closures: values.filter(value => value.closed).length,
    closedLaneCount,
    unknownDirection,
  };
}

const eventImpact = (event: TrafficEvent, distance: number) => {
  const base = event.kind === "accident" ? 11 : event.kind === "closure" ? 10 : event.kind === "obstruction" ? 6 : event.kind === "traffic" ? Math.min(10, 5 + Math.max(0, (event.queueLengthMeters ?? 0) / 1000)) : event.kind === "weather" ? 4 : 2;
  return base * Math.max(.2, 1 - distance / (MAX_EVENT_DISTANCE_KM + 1));
};

export function segmentEvents(seg: Segment, events: TrafficEvent[]) {
  const items = events.map(event => ({ event, distance: haversineKm(seg, event) }))
    .filter(({ event, distance }) => {
      if (distance > MAX_EVENT_DISTANCE_KM || (event.rayon && event.rayon !== seg.rayon) || (event.roadRef !== seg.road && event.roadRef !== null)) return false;
      const eventDirection = normalizeRoadDirection(event.direction);
      return !seg.direction || !eventDirection || eventDirection === seg.direction;
    });
  const points = items.map(item => eventImpact(item.event, item.distance) * (item.event.roadRef === seg.road ? 1 : .45)).sort((a, b) => b - a).slice(0, 3);
  return {
    items,
    score: Math.min(18, points.reduce((a, b) => a + b, 0)),
    accidents: items.filter(item => item.event.kind === "accident").length,
    obstructions: items.filter(item => item.event.kind === "obstruction" || item.event.kind === "closure").length,
  };
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
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") { points.push([value[0], value[1]]); return; }
    value.forEach(walk);
  };
  walk(geometry?.coordinates);
  if (!points.length) return null;
  const lng = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const lat = points.reduce((sum, point) => sum + point[1], 0) / points.length;
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
    const direction = normalizeRoadDirection(nearest.point.direction);
    const wvkId = pointWvkId(nearest.point);
    out.push({
      id: `rws-${nearest.point.road}-${nearest.point.km.toFixed(1)}-${index}`,
      name: featureName(feature.properties ?? {}),
      address: `${nearest.point.road} ${direction ?? ""} km ${nearest.point.km.toFixed(1)} · officiële RWS-verzorgingsplaats`.replace(/\s+/g, " "),
      lat: location.lat,
      lng: location.lng,
      kind: "service_area",
      source: "rws",
      verified: true,
      road: nearest.point.road,
      accessKm: nearest.point.km,
      direction,
      rayon: null,
      wvkId,
    });
  }
  return out;
}

const normalizeRoad = (value: unknown) => {
  const match = /^A\s*0*(\d{1,3})$/i.exec(String(value ?? "").trim());
  return match ? `A${Number(match[1])}` : null;
};
type GeoFeature = { id?: string | number; geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> };

export function parseRwsVildCandidates(payload: unknown, points: RoadMetringPoint[], kind: StandbyLocation["kind"], layerLabel: string): CandidateLocation[] {
  const features = (payload as { features?: GeoFeature[] })?.features ?? [];
  const out: CandidateLocation[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    const location = centroid(feature.geometry);
    const road = normalizeRoad(props.roadnumber);
    if (!location || !road) continue;
    const nearest = nearestRoadPoint(location, points, 2, road);
    if (!nearest) continue;
    const direction = normalizeRoadDirection(nearest.point.direction);
    const wvkId = pointWvkId(nearest.point);
    const rawName = [props.first_name, props.secnd_name].map(value => String(value ?? "").trim()).filter(value => value && value !== "-").join(" ");
    const name = rawName || `${layerLabel} ${road} km ${nearest.point.km.toFixed(1)}`;
    out.push({
      id: `rws-vild-${layerLabel.toLowerCase().replace(/\W+/g, "-")}-${feature.id ?? props.objectid ?? out.length}`,
      name,
      address: `${road} ${direction ?? ""} km ${nearest.point.km.toFixed(1)} · Rijkswaterstaat ${layerLabel.toLowerCase()}`.replace(/\s+/g, " "),
      lat: location.lat,
      lng: location.lng,
      kind,
      source: "rws",
      verified: true,
      road,
      accessKm: nearest.point.km,
      direction,
      rayon: null,
      wvkId,
    });
  }
  return out;
}

type OsmElement = { id: number; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: Record<string, string> };
const osmKind = (tags: Record<string, string>): StandbyLocation["kind"] => {
  if (tags.carpool === "yes" || tags.park_ride === "yes") return "carpool";
  if (tags.amenity === "fuel") return "fuel";
  if (tags.amenity === "parking") return "parking";
  if (tags.amenity === "restaurant" || tags.amenity === "fast_food") return "restaurant";
  return "other";
};
const osmName = (tags: Record<string, string>, road: string, km: number) => tags.name || tags.brand || tags.operator || `${osmKind(tags) === "parking" ? "Parkeerplaats" : "Stand-byplek"} ${road} km ${km.toFixed(1)}`;

export function parseOsmCandidates(payload: unknown, points: RoadMetringPoint[]): CandidateLocation[] {
  const elements = (payload as { elements?: OsmElement[] })?.elements ?? [];
  const out: CandidateLocation[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    if (tags.access === "private" || tags.access === "no" || tags.parking === "private") continue;
    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if (lat < 51.0 || lat > 52.45 || lng < 3.9 || lng > 6.65) continue;
    const nearest = nearestRoadPoint({ lat, lng }, points, 1.25);
    if (!nearest) continue;
    const kind = osmKind(tags);
    if (kind === "other") continue;
    const direction = normalizeRoadDirection(nearest.point.direction);
    const addressParts = [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]].filter(Boolean);
    out.push({
      id: `osm-${element.id}`,
      name: osmName(tags, nearest.point.road, nearest.point.km),
      address: addressParts.length ? addressParts.join(" ") : `${nearest.point.road} ${direction ?? ""} km ${nearest.point.km.toFixed(1)} · OSM-kandidaat nabij snelweg`.replace(/\s+/g, " "),
      lat,
      lng,
      kind,
      source: "osm",
      verified: false,
      road: nearest.point.road,
      accessKm: nearest.point.km,
      direction,
      rayon: null,
      wvkId: pointWvkId(nearest.point),
    });
  }
  const deduped = new Map<string, CandidateLocation>();
  for (const candidate of out) {
    const key = `${candidate.road}:${candidate.direction ?? "?"}:${Math.round(candidate.accessKm * 5) / 5}:${candidate.name.toLowerCase()}`;
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  return [...deduped.values()];
}

const locationQuality = (location: CandidateLocation) => location.source === "rws" && location.kind === "service_area" ? 18 : location.source === "rws" && location.kind === "fuel" ? 17 : location.source === "rws" ? 16 : location.kind === "fuel" ? 10 : location.kind === "parking" ? 9 : location.kind === "carpool" ? 8 : location.kind === "restaurant" ? 7 : 3;

export function chooseDynamicStandby(seg: Segment, locations: CandidateLocation[], alreadyChosen: CandidateLocation[]) {
  const candidates = locations.filter(location => {
    if (location.rayon !== seg.rayon || location.road !== seg.road || Math.abs(location.accessKm - seg.centerKm) > MAX_STANDBY_ROAD_DISTANCE_KM) return false;
    const locationDirection = normalizeRoadDirection(location.direction);
    return !seg.direction || !locationDirection || locationDirection === seg.direction;
  }).map(location => {
    const roadDistance = Math.abs(location.accessKm - seg.centerKm);
    const locationDirection = normalizeRoadDirection(location.direction);
    const directionVerified = Boolean(seg.direction && locationDirection && seg.direction === locationDirection);
    const reused = alreadyChosen.some(chosen => chosen.id === location.id);
    const overlap = alreadyChosen.some(chosen => chosen.road === location.road && normalizeRoadDirection(chosen.direction) === locationDirection && Math.abs(chosen.accessKm - location.accessKm) < 10);
    const directionPenalty = seg.direction && !locationDirection ? 8 : 0;
    const routeDistanceKm = roadDistance * (directionVerified ? 1 : 1.35);
    const routeEtaMinutes = Math.max(2, routeDistanceKm / 90 * 60 + 1.5);
    const routeVerified = location.source === "rws" && directionVerified;
    return {
      location: {
        ...location,
        routeDistanceKm: Math.round(routeDistanceKm * 10) / 10,
        routeEtaMinutes: Math.round(routeEtaMinutes * 10) / 10,
        routeVerified,
      },
      roadDistance,
      routeDistanceKm,
      routeEtaMinutes,
      routeVerified,
      rank: locationQuality(location) - routeDistanceKm * 1.15 - directionPenalty - (reused ? 18 : 0) - (overlap ? 5 : 0),
    };
  }).sort((a, b) => b.rank - a.rank || a.routeEtaMinutes - b.routeEtaMinutes);
  return candidates[0] ?? null;
}
