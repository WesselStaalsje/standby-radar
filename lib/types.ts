export type RoadDirection = "Li" | "Re" | null;

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
  direction?: RoadDirection;
  wvkId?: number | null;
  mappingDistanceMeters?: number | null;
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
  direction?: RoadDirection;
  road?: string | null;
  accessKm?: number | null;
  wvkId?: number | null;
  routeDistanceKm?: number | null;
  routeEtaMinutes?: number | null;
  routeVerified?: boolean;
};

export type SourceFamilyEvidence = {
  family: "physical" | "fcd" | "roadside" | "incident" | "weather" | "planning" | "external";
  available: boolean;
  pressure: number | null;
  quality: number;
  weight: number;
  detail: string;
};

export type ConsensusSummary = {
  score: number;
  reliability: number;
  conflict: boolean;
  spread: number;
  agreeingFamilies: number;
  evidence: SourceFamilyEvidence[];
};

export type HistoricalBaseline = {
  sampleCount: number;
  expectedSpeedKph: number | null;
  expectedFlowVehiclesPerHour: number | null;
  speedPercentile: number | null;
  flowPercentile: number | null;
  deviationScore: number;
  mature: boolean;
};

export type StandbyAdvice = {
  id: string;
  rayon: string;
  road: string;
  direction?: RoadDirection;
  wvkIds?: number[];
  segmentName: string;
  kmFrom: number;
  kmTo: number;
  score: number;
  pressure: "hoog" | "verhoogd" | "rustig";
  confidence: "hoog" | "middel" | "laag";
  recommendedUnits: number;
  sensorCount: number;
  rejectedSensorCount?: number;
  sensorQualityScore?: number | null;
  laneCount?: number | null;
  effectiveLaneCount?: number | null;
  flowPerLane?: number | null;
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
  fcdQualityScore?: number | null;
  fcdAvailability?: number | null;
  fcdTimeliness?: number | null;
  fcdCoverage?: number | null;
  temporarySpeedLimitKph?: number | null;
  dripSignalCount?: number;
  plannedEventCount?: number;
  srtiConfirmed?: boolean;
  supplementalScore?: number;
  trafficPressureScore?: number;
  incidentRisk30?: number;
  incidentRisk60?: number;
  reliabilityScore?: number;
  consensus?: ConsensusSummary;
  baseline?: HistoricalBaseline | null;
  routeDistanceKm?: number | null;
  routeEtaMinutes?: number | null;
  routeVerified?: boolean;
};

export type RayonRoadOverlay = {
  id: string;
  rayon: string;
  road: string;
  direction: RoadDirection;
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

export type FleetAssignment = {
  unit: number;
  adviceId: string;
  standbyId: string;
  standbyName: string;
  road: string;
  direction: RoadDirection;
  coveredRisk: number;
  marginalCoverage: number;
  etaMinutes: number | null;
};

export type FleetPlan = {
  requestedUnits: number;
  assignments: FleetAssignment[];
  coveredRiskPercent: number;
  uncoveredHighRiskSegments: string[];
};

export type LiveRadarData = {
  generatedAt: string;
  refreshAfterSeconds: number;
  region: string;
  events: TrafficEvent[];
  advice: StandbyAdvice[];
  sources: SourceStatus[];
  fleetPlan?: FleetPlan;
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
    directionSegmentCount?: number;
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
    routeVerifiedCount?: number;
    consensusConflictCount?: number;
    historyConfigured?: boolean;
    historySampleCount?: number;
    baselineMatureSegments?: number;
    backtestReady?: boolean;
  };
};
