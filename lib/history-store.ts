import { neon } from "@neondatabase/serverless";
import type { HistoricalBaseline, LiveRadarData, StandbyAdvice, TrafficEvent } from "@/lib/types";

const connectionString = () => process.env.STANDBY_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
export const historyConfigured = () => Boolean(connectionString());
const client = () => neon(connectionString());

const nullableNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

export async function saveRadarSnapshot(data: LiveRadarData, modelVersion: string) {
  if (!historyConfigured() || !data.advice.length) return { saved: false, snapshots: 0, events: 0 };
  const sql = client();
  const rows = data.advice.map(advice => ({
    observed_at: data.generatedAt,
    advice_id: advice.id,
    rayon: advice.rayon,
    road: advice.road,
    direction: advice.direction ?? null,
    km_from: advice.kmFrom,
    km_to: advice.kmTo,
    pressure_score: advice.score,
    traffic_pressure_score: advice.trafficPressureScore ?? null,
    incident_risk_30: advice.incidentRisk30 ?? null,
    incident_risk_60: advice.incidentRisk60 ?? null,
    reliability_score: advice.reliabilityScore ?? null,
    confidence: advice.confidence,
    source_conflict: advice.consensus?.conflict ?? false,
    speed_kph: nullableNumber(advice.averageSpeedKph),
    flow_vph: nullableNumber(advice.flowVehiclesPerHour),
    flow_per_lane: nullableNumber(advice.flowPerLane),
    lane_count: nullableNumber(advice.laneCount),
    effective_lane_count: nullableNumber(advice.effectiveLaneCount),
    sensor_count: advice.sensorCount,
    rejected_sensor_count: advice.rejectedSensorCount ?? 0,
    sensor_quality: nullableNumber(advice.sensorQualityScore),
    fcd_speed_kph: nullableNumber(advice.fcdAverageSpeedKph),
    fcd_quality: nullableNumber(advice.fcdQualityScore),
    fcd_availability: nullableNumber(advice.fcdAvailability),
    fcd_timeliness: nullableNumber(advice.fcdTimeliness),
    fcd_coverage: nullableNumber(advice.fcdCoverage),
    matrix_clusters: advice.matrixClusters,
    accidents: advice.accidents,
    obstructions: advice.obstructions,
    planned_events: advice.plannedEventCount ?? 0,
    precipitation: nullableNumber(advice.weather?.precipitation),
    visibility_m: nullableNumber(advice.weather?.visibility),
    wind_gust_kph: nullableNumber(advice.weather?.windGusts),
    standby_id: advice.standby.id,
    standby_name: advice.standby.name,
    standby_wvk_id: nullableNumber(advice.standby.wvkId),
    route_eta_minutes: nullableNumber(advice.routeEtaMinutes ?? advice.standby.routeEtaMinutes),
    route_distance_km: nullableNumber(advice.routeDistanceKm ?? advice.standby.routeDistanceKm),
    route_verified: advice.routeVerified ?? advice.standby.routeVerified ?? false,
    model_version: modelVersion,
  }));

  const events = data.events.map(event => ({
    event_id: event.id,
    first_seen_at: data.generatedAt,
    last_seen_at: data.generatedAt,
    kind: event.kind,
    road: event.roadRef,
    direction: event.direction ?? null,
    road_km: nullableNumber(event.roadKm),
    rayon: event.rayon ?? null,
    source: event.source,
    title: event.title,
    lat: event.lat,
    lng: event.lng,
    wvk_id: nullableNumber(event.wvkId),
    starts_at: event.startsAt ?? null,
    ends_at: event.endsAt ?? null,
    payload: event,
  }));

  await sql.query(`
    INSERT INTO radar_snapshots (
      observed_at, advice_id, rayon, road, direction, km_from, km_to,
      pressure_score, traffic_pressure_score, incident_risk_30, incident_risk_60,
      reliability_score, confidence, source_conflict, speed_kph, flow_vph,
      flow_per_lane, lane_count, effective_lane_count, sensor_count,
      rejected_sensor_count, sensor_quality, fcd_speed_kph, fcd_quality,
      fcd_availability, fcd_timeliness, fcd_coverage, matrix_clusters, accidents,
      obstructions, planned_events, precipitation, visibility_m, wind_gust_kph,
      standby_id, standby_name, standby_wvk_id, route_eta_minutes,
      route_distance_km, route_verified, model_version
    )
    SELECT
      x.observed_at::timestamptz, x.advice_id, x.rayon, x.road, x.direction,
      x.km_from, x.km_to, x.pressure_score, x.traffic_pressure_score,
      x.incident_risk_30, x.incident_risk_60, x.reliability_score, x.confidence,
      x.source_conflict, x.speed_kph, x.flow_vph, x.flow_per_lane, x.lane_count,
      x.effective_lane_count, x.sensor_count, x.rejected_sensor_count,
      x.sensor_quality, x.fcd_speed_kph, x.fcd_quality, x.fcd_availability,
      x.fcd_timeliness, x.fcd_coverage, x.matrix_clusters, x.accidents,
      x.obstructions, x.planned_events, x.precipitation, x.visibility_m,
      x.wind_gust_kph, x.standby_id, x.standby_name, x.standby_wvk_id,
      x.route_eta_minutes, x.route_distance_km, x.route_verified, x.model_version
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
      precipitation numeric, visibility_m integer, wind_gust_kph numeric,
      standby_id text, standby_name text, standby_wvk_id bigint,
      route_eta_minutes numeric, route_distance_km numeric, route_verified boolean,
      model_version text
    )
    ON CONFLICT (advice_id, observed_at) DO NOTHING
  `, [JSON.stringify(rows)]);

  if (events.length) {
    await sql.query(`
      INSERT INTO radar_events (
        event_id, first_seen_at, last_seen_at, kind, road, direction, road_km,
        rayon, source, title, lat, lng, wvk_id, starts_at, ends_at, payload
      )
      SELECT x.event_id, x.first_seen_at::timestamptz, x.last_seen_at::timestamptz,
        x.kind, x.road, x.direction, x.road_km, x.rayon, x.source, x.title,
        x.lat, x.lng, x.wvk_id, x.starts_at::timestamptz, x.ends_at::timestamptz,
        x.payload
      FROM jsonb_to_recordset($1::jsonb) AS x(
        event_id text, first_seen_at text, last_seen_at text, kind text, road text,
        direction text, road_km numeric, rayon text, source text, title text,
        lat double precision, lng double precision, wvk_id bigint, starts_at text,
        ends_at text, payload jsonb
      )
      ON CONFLICT (event_id) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        direction = COALESCE(radar_events.direction, EXCLUDED.direction),
        road_km = COALESCE(radar_events.road_km, EXCLUDED.road_km),
        wvk_id = COALESCE(radar_events.wvk_id, EXCLUDED.wvk_id),
        payload = EXCLUDED.payload
    `, [JSON.stringify(events)]);
  }
  return { saved: true, snapshots: rows.length, events: events.length };
}

type BaselineRow = {
  road: string;
  direction: string | null;
  km_from: string | number;
  km_to: string | number;
  sample_count: number;
  median_speed_kph: string | number | null;
  p10_speed_kph: string | number | null;
  p90_speed_kph: string | number | null;
  median_flow_vph: string | number | null;
  p10_flow_vph: string | number | null;
  p90_flow_vph: string | number | null;
};

export async function loadCurrentBaselines(): Promise<Map<string, HistoricalBaseline>> {
  const out = new Map<string, HistoricalBaseline>();
  if (!historyConfigured()) return out;
  const sql = client();
  const rows = await sql.query(`
    SELECT road, direction, km_from, km_to, sample_count, median_speed_kph,
      p10_speed_kph, p90_speed_kph, median_flow_vph, p10_flow_vph, p90_flow_vph
    FROM radar_segment_baseline
    WHERE iso_weekday = EXTRACT(ISODOW FROM now() AT TIME ZONE 'Europe/Amsterdam')::smallint
      AND quarter_of_day = FLOOR((EXTRACT(HOUR FROM now() AT TIME ZONE 'Europe/Amsterdam') * 60 + EXTRACT(MINUTE FROM now() AT TIME ZONE 'Europe/Amsterdam')) / 15)::smallint
  `) as BaselineRow[];
  for (const row of rows) {
    const speed = row.median_speed_kph === null ? null : Number(row.median_speed_kph);
    const flow = row.median_flow_vph === null ? null : Number(row.median_flow_vph);
    const key = `${row.road}:${row.direction ?? "?"}:${Number(row.km_from).toFixed(1)}:${Number(row.km_to).toFixed(1)}`;
    out.set(key, {
      sampleCount: Number(row.sample_count),
      expectedSpeedKph: Number.isFinite(speed) ? speed : null,
      expectedFlowVehiclesPerHour: Number.isFinite(flow) ? flow : null,
      speedPercentile: null,
      flowPercentile: null,
      deviationScore: 0,
      mature: Number(row.sample_count) >= 12,
    });
  }
  return out;
}

export function baselineKey(advice: Pick<StandbyAdvice, "road" | "direction" | "kmFrom" | "kmTo">) {
  return `${advice.road}:${advice.direction ?? "?"}:${advice.kmFrom.toFixed(1)}:${advice.kmTo.toFixed(1)}`;
}

export async function backtestReadiness() {
  if (!historyConfigured()) return { configured: false, ready: false, snapshotCount: 0, daysCollected: 0, segmentCount: 0, firstSnapshot: null, lastSnapshot: null };
  const sql = client();
  const [row] = await sql.query(`SELECT * FROM radar_backtest_readiness`) as Array<Record<string, unknown>>;
  return {
    configured: true,
    ready: Boolean(row?.ready),
    snapshotCount: Number(row?.snapshot_count ?? 0),
    daysCollected: Number(row?.days_collected ?? 0),
    segmentCount: Number(row?.segment_count ?? 0),
    firstSnapshot: row?.first_snapshot ?? null,
    lastSnapshot: row?.last_snapshot ?? null,
  };
}

export async function runStoredBacktest(from: string, to: string, threshold = 65) {
  if (!historyConfigured()) return { configured: false, ready: false, error: "history-not-configured" };
  const sql = client();
  const rows = await sql.query(`
    SELECT
      s.observed_at, s.advice_id, s.road, s.direction, s.km_from, s.km_to,
      COALESCE(s.incident_risk_30, 0) AS risk30,
      EXISTS (
        SELECT 1 FROM radar_events e
        WHERE e.road = s.road
          AND (s.direction IS NULL OR e.direction IS NULL OR e.direction = s.direction)
          AND e.first_seen_at > s.observed_at
          AND e.first_seen_at <= s.observed_at + interval '30 minutes'
          AND (e.road_km IS NULL OR e.road_km BETWEEN s.km_from - 1.0 AND s.km_to + 1.0)
          AND e.kind IN ('accident','obstruction','closure')
      ) AS actual30
    FROM radar_snapshots s
    WHERE s.observed_at >= $1::timestamptz AND s.observed_at <= $2::timestamptz
    ORDER BY s.observed_at
    LIMIT 250000
  `, [from, to]) as Array<{ risk30: number | string; actual30: boolean }>;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const row of rows) {
    const predicted = Number(row.risk30) >= threshold;
    if (predicted && row.actual30) tp += 1;
    else if (predicted) fp += 1;
    else if (row.actual30) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const falsePositiveRate = fp + tn ? fp / (fp + tn) : null;
  const result = { configured: true, ready: rows.length > 0, sampleCount: rows.length, threshold, tp, fp, tn, fn, precision, recall, falsePositiveRate };
  if (rows.length) {
    await sql.query(`
      INSERT INTO backtest_runs (from_time, to_time, model_version, sample_count, event_count, precision_score, recall_score, false_positive_rate, result)
      VALUES ($1::timestamptz, $2::timestamptz, '2.0-operational-reliability', $3, $4, $5, $6, $7, $8::jsonb)
    `, [from, to, rows.length, tp + fn, precision, recall, falsePositiveRate, JSON.stringify(result)]);
  }
  return result;
}
