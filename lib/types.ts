export type TrafficKind = "traffic" | "accident" | "obstruction" | "closure" | "works" | "weather";

export type TrafficEvent = {
  id: string;
  kind: TrafficKind;
  title: string;
  type: string;
  lat: number;
  lng: number;
  roadRef: string | null;
  queueLengthMeters: number | null;
  source: string | null;
  updatedAt: string | null;
  rayon?: string | null;
  roadKm?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  planned?: boolean;
};

export type WeatherSnapshot = {
  precipitation: number;
  windGusts: number;
  visibility: number;
  weatherCode: number | null;
  observedAt: string | null;
};

export type StandbyLocation = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  kind: "restaurant" | "service_area" | "parking" | "fuel" | "carpool" | "other";
  source: "rws" | "osm";
  verified: boolean;
};

export type StandbyAdvice = {
  id: string;
  rayon: string;
  road: string;
  segmentName: string;
  kmFrom: number;
  kmTo: number;
  score: number;
  pressure: "hoog" | "verhoogd" | "rustig";
  confidence: "hoog" | "middel" | "laag";
  recommendedUnits: number;
  sensorCount: number;
  averageSpeedKph: number | null;
  flowVehiclesPerHour: number | null;
  congestionIndex: number;
  localEvents: number;
  accidents: number;
  obstructions: number;
  matrixClusters: number;
  lowSpeedMatrixClusters: number;
  corroboratingSignals: number;
  corroboratingSignalMax?: number;
  reasons: string[];
  weather: WeatherSnapshot | null;
  standby: StandbyLocation;
  travelTimeSampleCount?: number;
  fcdAverageSpeedKph?: number | null;
  temporarySpeedLimitKph?: number | null;
  dripSignalCount?: number;
  plannedEventCount?: number;
  srtiConfirmed?: boolean;
  supplementalScore?: number;
};

export type RayonRoadOverlay = {
  id: string;
  rayon: string;
  road: string;
  direction: "Li" | "Re" | null;
  fromKm: number;
  toKm: number;
  coordinates: Array<[number, number]>;
};

export type SourceStatus = {
  id: string;
  name: string;
  ok: boolean;
  updatedAt: string | null;
  error: string | null;
  lineage?: string | null;
};

export type MatrixRoadSummary = {
  road: string;
  active: number;
  closures: number;
  lowSpeed: number;
};

export type LiveRadarData = {
  generatedAt: string;
  refreshAfterSeconds: number;
  region: string;
  events: TrafficEvent[];
  advice: StandbyAdvice[];
  sources: SourceStatus[];
  rayons: {
    codes: string[];
    roadOverlays: RayonRoadOverlay[];
  };
  matrix: {
    activeSignals: number;
    byRoad: MatrixRoadSummary[];
  };
  meta: {
    eventCount: number;
    accidentCount: number;
    obstructionCount: number;
    trafficCount: number;
    closureCount: number;
    segmentCount: number;
    measuredSiteCount: number;
    candidateLocationCount: number;
    rayonCount: number;
    roadCount: number;
    roads: string[];
    rushHour: boolean;
    modelVersion: string;
    note: string;
    tomtomConfigured?: boolean;
    tomtomCoverageSegments?: number;
    tomtomTileCount?: number;
    travelTimeSiteCount?: number;
    travelTimeSampleCount?: number;
    fcdCoverageSegments?: number;
    dripSignalCount?: number;
    plannedEventCount?: number;
    temporarySpeedRestrictionCount?: number;
    srtiEventCount?: number;
    bridgeEventCount?: number;
  };
};