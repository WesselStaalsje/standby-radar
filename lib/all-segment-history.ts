import { neon } from "@neondatabase/serverless";
import type { LiveRadarData, RoadDirection } from "@/lib/types";
import {
  normalizeRoadDirection,
  segmentEvents,
  segmentMatrix,
  sensorMetrics,
  type Segment,
} from "@/lib/engine-v2";
import {
  exactRange,
  loadV5Live,
  loadV5Static,
  type V5StaticContext,
} from "@/lib/live-v5-data";
import { travelTimeMetricsV2 } from "@/lib/ndw-traveltime-v2";

const SEGMENT_LENGTH_KM = 5;
const connectionString = () => process.env.STANDBY_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));

function buildDirectionalSegments(context: V5StaticContext): Segment[] {
  type Bucket = {
    rayon: string;
    road: string;
    direction: RoadDirection;
    bucketFrom: number;
    kmFrom: number;
    kmTo: number;
  };

  const buckets = new Map<string, Bucket>();
  for (const range of context.ranges) {
    const direction = normalizeRoadDirection(range.direction);
    let bucketFrom = Math.floor(range.fromKm / SEGMENT_LENGTH_KM) * SEGMENT_LENGTH_KM;
    while (bucketFrom < range.toKm) {
      const kmFrom = Math.max(bucketFrom, range.fromKm);
      const kmTo = Math.min(bucketFrom + SEGMENT_LENGTH_KM, range.toKm);
      if (kmTo > kmFrom) {
        const key = `${range.rayon}:${range.road}:${direction ?? "B"}:${bucketFrom}`;
        const existing = buckets.get(key);
        if (existing) {
          existing.kmFrom = Math.min(existing.kmFrom, kmFrom);
          existing.kmTo = Math.max(existing.kmTo, kmTo);
        } else {
          buckets.set(key, { rayon: range.rayon, road: range.road, direction, bucketFrom, kmFrom, kmTo });
        }
      }
      bucketFrom += SEGMENT_LENGTH_KM;
    }
  }

  const segments: Segment[] = [];
  for (const bucket of buckets.values()) {
    const sites = context.sites.filter(site => {
      if (site.rayon !== bucket.rayon || site.road !== bucket.road || site.km < bucket.kmFrom || site.km > bucket.kmTo) return false;
      const direction = normalizeRoadDirection(site.direction);
      return !bucket.direction || !direction || direction === bucket.direction;
    });
    const points = context.roadPoints.filter(point => {
      if (point.road !== bucket.road || point.km < bucket.kmFrom || point.km > bucket.kmTo) return false;
      const direction = normalizeRoadDirection(point.direction);
      if (bucket.direction && direction && bucket.direction !== direction) return false;
      const range = exactRange(point.road, point.km, direction, context.ranges);
      return range?.rayon === bucket.rayon;
    });
    const centerKm = (bucket.kmFrom + bucket.kmTo) / 2;
    const representative = points.slice().sort((a, b) => Math.abs(a.km - centerKm) - Math.abs(b.km - centerKm))[0];
    const lat = representative?.lat ?? (sites.length ? sites.reduce((sum, site) => sum + site.lat, 0) / sites.length : null);
    const lng = representative?.lng ?? (sites.length ? sites.reduce((sum, site) => sum + site.lng, 0) / sites.length : null);
    if (lat === null || lng === null) continue;
    const wvkIds = [...new Set([
      ...points.map(point => point.wvkId),
      ...sites.map(site => site.wvkId ?? null),
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value)))];
    segments.push({
      rayon: bucket.rayon,
      road: bucket.road,
      direction: bucket.direction,
      kmFrom: Math.round(bucket.kmFrom * 10) / 10,
      kmTo: Math.round(bucket.kmTo * 10) / 10,
      centerKm,
      lat,
      lng,
      wvkIds,
      sites,
    });
  }
  return segments;
}

const segmentId = (segment: Segment) => `${segment.rayon}-${segment.road}-${segment.direction ?? "B"}-${segment.kmFrom}-${segment.kmTo}`;

function travelPressure(speed: number | null) {
  if (speed === null) return 0;
  if (speed < 35) return 100;
  if (speed < 50) return 85;
  if (speed < 65) return 68;
  if (speed < 80) return 48;
  if (speed < 95) return 24;
  return 0;
}

export async function saveAllDirectionalSegmentSnapshots(data: LiveRadarData, modelVersion: string) {
  const url = connectionString();
  if (!url) return { configured: false, segmentCount: 0, addedRows: 0 };

  const [context, live] = await (async () => {
    const staticContext = await loadV5Static();
    return [staticContext, await loadV5Live(staticContext)] as const;
  })();
  const segments = buildDirectionalSegments(context);
  const alreadySaved = new Set(data.advice.map(advice => advice.id));

  const rows = segments.flatMap(segment => {
    const id = segmentId(segment);
    if (alreadySaved.has(id)) return [];

    const msi = segmentMatrix(live.matrix, segment);
    const sensor = sensorMetrics(segment, live.samples, msi.closedLaneCount);
    const incident = segmentEvents(segment, data.events);
    const travel = travelTimeMetricsV2(segment, context.travelSites, live.travelSamples);

    const fcdPressure = travelPressure(travel.averageSpeedKph);
    const trafficPressureScore = Math.round(clamp(Math.max(
      sensor.congestionIndex,
      fcdPressure,
      Math.min(100, msi.clusters * 18 + msi.lowSpeed * 8),
    )));
    const pressureScore = Math.round(clamp(
      sensor.score + msi.score + incident.score + (sensor.sensorCount === 0 ? travel.score : 0),
      0,
      96,
    ));
    const reliabilityScore = Math.round(clamp(
      (sensor.qualityScore ?? 0) * 0.55 + (travel.qualityScore ?? 0) * 0.35 + (msi.clusters > 0 ? 88 : 0) * 0.10,
      sensor.sensorCount === 0 && travel.sampleCount === 0 ? 20 : 35,
      92,
    ));
    const eventScore = Math.min(38, incident.accidents * 24 + incident.obstructions * 12);
    const matrixScore = Math.min(16, msi.clusters * 3 + msi.lowSpeed * 2);
    const incidentRisk30 = Math.round(clamp(trafficPressureScore * 0.26 + eventScore + matrixScore * 0.7));
    const incidentRisk60 = Math.round(clamp(trafficPressureScore * 0.30 + eventScore * 0.8 + matrixScore * 0.6));

    return [{
      observed_at: data.generatedAt,
      advice_id: id,
      rayon: segment.rayon,
      road: segment.road,
      direction: segment.direction,
      km_from: segment.kmFrom,
      km_to: segment.kmTo,
      pressure_score: pressureScore,
      traffic_pressure_score: trafficPressureScore,
      incident_risk_30: incidentRisk30,
      incident_risk_60: incidentRisk60,
      reliability_score: reliabilityScore,
      confidence: reliabilityScore >= 78 ? "hoog" : reliabilityScore >= 50 ? "middel" : "laag",
      source_conflict: false,
      speed_kph: sensor.averageSpeedKph,
      flow_vph: sensor.flowVehiclesPerHour,
      flow_per_lane: sensor.flowPerLane,
      lane_count: sensor.laneCount,
      effective_lane_count: sensor.effectiveLaneCount,
      sensor_count: sensor.sensorCount,
      rejected_sensor_count: sensor.rejectedSensorCount,
      sensor_quality: sensor.qualityScore,
      fcd_speed_kph: travel.averageSpeedKph,
      fcd_quality: travel.qualityScore,
      fcd_availability: travel.availability,
      fcd_timeliness: travel.timeliness,
      fcd_coverage: travel.coverage,
      matrix_clusters: msi.clusters,
      accidents: incident.accidents,
      obstructions: incident.obstructions,
      planned_events: 0,
      model_version: modelVersion,
    }];
  });

  if (!rows.length) return { configured: true, segmentCount: segments.length, addedRows: 0 };
  const sql = neon(url);
  await sql.query(`
    INSERT INTO radar_snapshots (
      observed_at, advice_id, rayon, road, direction, km_from, km_to,
      pressure_score, traffic_pressure_score, incident_risk_30, incident_risk_60,
      reliability_score, confidence, source_conflict, speed_kph, flow_vph,
      flow_per_lane, lane_count, effective_lane_count, sensor_count,
      rejected_sensor_count, sensor_quality, fcd_speed_kph, fcd_quality,
      fcd_availability, fcd_timeliness, fcd_coverage, matrix_clusters, accidents,
      obstructions, planned_events, standby_id, standby_name, standby_wvk_id,
      route_eta_minutes, route_distance_km, route_verified, model_version
    )
    SELECT
      x.observed_at::timestamptz, x.advice_id, x.rayon, x.road, x.direction,
      x.km_from, x.km_to, x.pressure_score, x.traffic_pressure_score,
      x.incident_risk_30, x.incident_risk_60, x.reliability_score, x.confidence,
      x.source_conflict, x.speed_kph, x.flow_vph, x.flow_per_lane, x.lane_count,
      x.effective_lane_count, x.sensor_count, x.rejected_sensor_count,
      x.sensor_quality, x.fcd_speed_kph, x.fcd_quality, x.fcd_availability,
      x.fcd_timeliness, x.fcd_coverage, x.matrix_clusters, x.accidents,
      x.obstructions, x.planned_events, NULL, NULL, NULL, NULL, NULL, false,
      x.model_version
    FROM jsonb_to_recordset($1::jsonb) AS x(
      observed_at text, advice_id text, rayon text, road text, direction text,
      km_from numeric, km_to numeric, pressure_score smallint,
      traffic_pressure_score smallint, incident_risk_30 smallint,
      incident_risk_60 smallint, reliability_score smallint, confidence text,
      source_conflict boolean, speed_kph numeric, flow_vph integer,
      flow_per_lane integer, lane_count smallint, effective_lane_count smallint,
      sensor_count smallint, rejected_sensor_count smallint, sensor_quality smallint,
      fcd_speed_kph numeric, fcd_quality smallint, fcd_availability smallint,
      fcd_timeliness smallint, fcd_coverage smallint, matrix_clusters smallint,
      accidents smallint, obstructions smallint, planned_events smallint,
      model_version text
    )
    ON CONFLICT (advice_id, observed_at) DO NOTHING
  `, [JSON.stringify(rows)]);

  return { configured: true, segmentCount: segments.length, addedRows: rows.length };
}
