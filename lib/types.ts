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
};

export type WeatherSnapshot = {
  precipitation: number;
  windGusts: number;
  visibility: number;
  weatherCode: number | null;
  observedAt: string | null;
};

export type StandbyAdvice = {
  id: string;
  name: string;
  province: string;
  lat: number;
  lng: number;
  roads: readonly string[];
  score: number;
  confidence: "hoog" | "middel" | "laag";
  recommendedUnits: number;
  nearbyEvents: number;
  matrixClusters: number;
  reasons: string[];
  weather: WeatherSnapshot | null;
};

export type SourceStatus = {
  id: string;
  name: string;
  ok: boolean;
  updatedAt: string | null;
  error: string | null;
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
    rushHour: boolean;
    modelVersion: string;
    note: string;
  };
};