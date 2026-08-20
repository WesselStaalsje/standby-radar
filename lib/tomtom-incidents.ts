import type { LiveRadarData, RoadDirection, TrafficEvent } from "@/lib/types";

type Overlay = LiveRadarData["rayons"]["roadOverlays"][number];
type GeoPoint = { lat: number; lng: number };

type TomTomIncident = {
  type?: string;
  geometry?: {
    type?: "Point" | "LineString" | string;
    coordinates?: unknown;
  };
  properties?: {
    id?: string;
    iconCategory?: number;
    magnitudeOfDelay?: number;
    events?: Array<{ description?: string; code?: number; iconCategory?: number }>;
    startTime?: string | null;
    endTime?: string | null;
    from?: string | null;
    to?: string | null;
    length?: number;
    delay?: number | null;
    roadNumbers?: string[];
    timeValidity?: string;
    probabilityOfOccurrence?: string;
    numberOfReports?: number | null;
    lastReportTime?: string | null;
  };
};

type TomTomIncidentResponse = { incidents?: TomTomIncident[] };

export type TomTomBrokenDownResult = {
  configured: boolean;
  updatedAt: string | null;
  events: TrafficEvent[];
  rawCount: number;
  matchedCount: number;
  successfulBoxes: number;
  error: string | null;
};

const BBOXES = [
  [4.20, 51.15, 5.40, 51.75],
  [4.20, 51.70, 5.40, 52.30],
  [5.30, 51.15, 6.55, 51.75],
  [5.30, 51.70, 6.55, 52.30],
] as const;

const FIELDS = "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime}}}";
const MAX_OVERLAY_MATCH_METERS = 900;

const rad = (value: number) => value * Math.PI / 180;

function distanceMeters(a: GeoPoint, b: GeoPoint) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function overlayLengthMeters(overlay: Overlay) {
  let total = 0;
  for (let index = 1; index < overlay.coordinates.length; index += 1) {
    const a = overlay.coordinates[index - 1];
    const b = overlay.coordinates[index];
    total += distanceMeters({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
  }
  return total;
}

function usableOverlay(overlay: Overlay) {
  const expectedMeters = Math.max(100, (overlay.toKm - overlay.fromKm) * 1000);
  return overlay.coordinates.length >= 2 && overlayLengthMeters(overlay) >= Math.max(500, expectedMeters * .35);
}

function pointToSegment(point: GeoPoint, a: GeoPoint, b: GeoPoint) {
  const latRad = rad(point.lat);
  const scaleX = 111_320 * Math.cos(latRad);
  const scaleY = 110_540;
  const ax = (a.lng - point.lng) * scaleX;
  const ay = (a.lat - point.lat) * scaleY;
  const bx = (b.lng - point.lng) * scaleX;
  const by = (b.lat - point.lat) * scaleY;
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0;
  return { distance: Math.hypot(ax + t * dx, ay + t * dy), t };
}

function matchOverlay(point: GeoPoint, road: string, overlays: Overlay[]) {
  let best: { overlay: Overlay; distance: number; fraction: number } | null = null;
  for (const overlay of overlays) {
    if (overlay.road !== road || !usableOverlay(overlay)) continue;
    const legs: number[] = [];
    let total = 0;
    for (let index = 1; index < overlay.coordinates.length; index += 1) {
      const a = overlay.coordinates[index - 1];
      const b = overlay.coordinates[index];
      const leg = distanceMeters({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
      legs.push(leg);
      total += leg;
    }
    if (!total) continue;

    let traversed = 0;
    for (let index = 1; index < overlay.coordinates.length; index += 1) {
      const a = overlay.coordinates[index - 1];
      const b = overlay.coordinates[index];
      const hit = pointToSegment(point, { lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
      const fraction = Math.max(0, Math.min(1, (traversed + legs[index - 1] * hit.t) / total));
      if (!best || hit.distance < best.distance) best = { overlay, distance: hit.distance, fraction };
      traversed += legs[index - 1];
    }
  }
  return best && best.distance <= MAX_OVERLAY_MATCH_METERS ? best : null;
}

function representativePoint(incident: TomTomIncident): GeoPoint | null {
  const coordinates = incident.geometry?.coordinates;
  if (incident.geometry?.type === "Point" && Array.isArray(coordinates) && coordinates.length >= 2) {
    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  if (incident.geometry?.type === "LineString" && Array.isArray(coordinates) && coordinates.length) {
    const middle = coordinates[Math.floor(coordinates.length / 2)];
    if (Array.isArray(middle) && middle.length >= 2) {
      const lng = Number(middle[0]);
      const lat = Number(middle[1]);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }
  }
  return null;
}

function normalizeRoadNumbers(values: string[] | undefined) {
  const roads = new Set<string>();
  for (const value of values ?? []) {
    for (const match of value.toUpperCase().matchAll(/\bA\s*0*(\d{1,3})\b/g)) roads.add(`A${Number(match[1])}`);
  }
  return [...roads];
}

function direction(value: RoadDirection): RoadDirection {
  return value === "Li" || value === "Re" ? value : null;
}

function convertIncident(incident: TomTomIncident, overlays: Overlay[]): TrafficEvent | null {
  if (incident.properties?.iconCategory !== 14) return null;
  const point = representativePoint(incident);
  if (!point) return null;
  const roads = normalizeRoadNumbers(incident.properties.roadNumbers);
  let matched: ReturnType<typeof matchOverlay> = null;
  let matchedRoad: string | null = null;
  for (const road of roads) {
    const candidate = matchOverlay(point, road, overlays);
    if (candidate && (!matched || candidate.distance < matched.distance)) {
      matched = candidate;
      matchedRoad = road;
    }
  }
  if (!matched || !matchedRoad) return null;

  const roadKm = matched.overlay.fromKm + (matched.overlay.toKm - matched.overlay.fromKm) * matched.fraction;
  const description = incident.properties?.events?.map(item => item.description?.trim()).find(Boolean);
  const id = incident.properties?.id ?? `${matchedRoad}-${point.lat.toFixed(5)}-${point.lng.toFixed(5)}`;
  return {
    id: `TOMTOM-BDV-${id}`,
    kind: "obstruction",
    title: description ? `Stilstaand / defect voertuig · ${description}` : "Stilstaand / defect voertuig",
    type: "TomTomBrokenDownVehicle",
    lat: point.lat,
    lng: point.lng,
    roadRef: matchedRoad,
    roadKm: Math.round(roadKm * 10) / 10,
    direction: direction(matched.overlay.direction),
    queueLengthMeters: null,
    source: "TomTom Traffic",
    updatedAt: incident.properties?.lastReportTime ?? incident.properties?.startTime ?? new Date().toISOString(),
    rayon: matched.overlay.rayon,
    mappingDistanceMeters: Math.round(matched.distance),
    startsAt: incident.properties?.startTime ?? null,
    endsAt: incident.properties?.endTime ?? null,
  };
}

async function fetchBox(box: readonly [number, number, number, number], apiKey: string) {
  const params = new URLSearchParams({
    key: apiKey,
    bbox: box.join(","),
    fields: FIELDS,
    language: "nl-NL",
    categoryFilter: "BrokenDownVehicle",
    timeValidityFilter: "present",
  });
  const response = await fetch(`https://api.tomtom.com/traffic/services/5/incidentDetails?${params}`, {
    next: { revalidate: 60 },
    signal: AbortSignal.timeout(8_000),
    headers: { "user-agent": "StandbyRadar/2.3", "accept-encoding": "gzip" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { payload: await response.json() as TomTomIncidentResponse, updatedAt: response.headers.get("date") ?? new Date().toISOString() };
}

export async function fetchTomTomBrokenDownVehicles(
  overlays: Overlay[],
  apiKey: string | undefined,
): Promise<TomTomBrokenDownResult> {
  if (!apiKey) return { configured: false, updatedAt: null, events: [], rawCount: 0, matchedCount: 0, successfulBoxes: 0, error: "TOMTOM_API_KEY ontbreekt" };

  const settled = await Promise.allSettled(BBOXES.map(box => fetchBox(box, apiKey)));
  const errors: string[] = [];
  const incidents = new Map<string, TomTomIncident>();
  let updatedAt: string | null = null;
  let successfulBoxes = 0;

  for (const result of settled) {
    if (result.status !== "fulfilled") {
      errors.push(result.reason instanceof Error ? result.reason.message : "TomTom incidentfeed fout");
      continue;
    }
    successfulBoxes += 1;
    updatedAt = result.value.updatedAt ?? updatedAt;
    for (const incident of result.value.payload.incidents ?? []) {
      const point = representativePoint(incident);
      const key = incident.properties?.id ?? (point ? `${point.lat.toFixed(5)}:${point.lng.toFixed(5)}` : JSON.stringify(incident));
      incidents.set(key, incident);
    }
  }

  const events = [...incidents.values()].flatMap(incident => {
    const event = convertIncident(incident, overlays);
    return event ? [event] : [];
  });

  return {
    configured: true,
    updatedAt,
    events,
    rawCount: incidents.size,
    matchedCount: events.length,
    successfulBoxes,
    error: errors.length ? `${errors.length}/${BBOXES.length} gebied(en) niet geladen: ${[...new Set(errors)].join("; ")}` : null,
  };
}
