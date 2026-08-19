import type { RoadDirection } from "@/lib/types";
import type { MeasurementSite, SiteTraffic, MatrixSignal, RoadMetringPoint } from "@/lib/ndw";
import type { TrafficEvent, WeatherSnapshot, StandbyLocation } from "@/lib/types";
import * as strict from "@/lib/engine-v2";

export const SEGMENT_LENGTH_KM = strict.SEGMENT_LENGTH_KM;
export const MAX_EVENT_DISTANCE_KM = strict.MAX_EVENT_DISTANCE_KM;
export const MAX_STANDBY_ROAD_DISTANCE_KM = strict.MAX_STANDBY_ROAD_DISTANCE_KM;
export const normalizeRoadDirection = strict.normalizeRoadDirection;
export const median = strict.median;
export const haversineKm = strict.haversineKm;
export const weatherScore = strict.weatherScore;
export const parseRwsRestAreas = strict.parseRwsRestAreas;
export const parseRwsVildCandidates = strict.parseRwsVildCandidates;
export const parseOsmCandidates = strict.parseOsmCandidates;

export type CandidateLocation = StandbyLocation & {
  road: string;
  accessKm: number;
  direction: string | null;
  rayon: string | null;
  wvkId?: number | null;
};

export type ScopedMeasurementSite = MeasurementSite & {
  rayon: string;
  rangeFromKm: number;
  rangeToKm: number;
};

// Transitional shape used by the current v1 live route. The strict v2 engine
// always normalizes this into an explicit direction + WVK list before scoring.
export type Segment = {
  rayon: string;
  road: string;
  direction?: RoadDirection;
  kmFrom: number;
  kmTo: number;
  centerKm: number;
  lat: number;
  lng: number;
  wvkIds?: number[];
  sites: MeasurementSite[];
};

const strictSegment = (segment: Segment): strict.Segment => ({
  ...segment,
  direction: segment.direction ?? null,
  wvkIds: segment.wvkIds ?? [],
});

const strictCandidates = (locations: CandidateLocation[]): strict.CandidateLocation[] => locations.map(location => ({
  ...location,
  direction: strict.normalizeRoadDirection(location.direction),
}));

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
  }).filter(segment => segment.kmTo > segment.kmFrom);
}

export function sensorMetrics(segment: Segment, samples: Map<string, SiteTraffic>, closedLaneCount = 0) {
  return strict.sensorMetrics(strictSegment(segment), samples, closedLaneCount);
}

export function segmentMatrix(signals: MatrixSignal[], segment: Segment) {
  return strict.segmentMatrix(signals, strictSegment(segment));
}

export function segmentEvents(segment: Segment, events: TrafficEvent[]) {
  return strict.segmentEvents(strictSegment(segment), events);
}

export function chooseDynamicStandby(segment: Segment, locations: CandidateLocation[], alreadyChosen: CandidateLocation[]) {
  return strict.chooseDynamicStandby(strictSegment(segment), strictCandidates(locations), strictCandidates(alreadyChosen));
}
