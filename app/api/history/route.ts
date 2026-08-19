import { NextResponse } from "next/server";
import type { RoadMetringPoint } from "@/lib/ndw";
import { parseRoadMetringPoints } from "@/lib/ndw";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BRON_QUERY = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/verkeersongevallen_nederland/FeatureServer/3/query";
const RWS_METERING = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/nwb_metrering/MapServer/2/query";
const BBOX = { minLat: 51.15, minLng: 4.20, maxLat: 52.30, maxLng: 6.55 };
const PAGE_SIZE = 1000;
const MAX_SNAP_METERS = 220;

type BronFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    jaar_ongeval?: number | null;
    verkeersongeval_afloop?: string | null;
    aard_ongeval?: string | null;
    wegbeheerder?: string | null;
  };
};

type HistoricalSegment = {
  id: string;
  road: string;
  kmFrom: number;
  kmTo: number;
  accidents: number;
  weightedRisk: number;
  historyScore: number;
  years: number[];
  severe: number;
};

const severityWeight = (outcome: string | null | undefined) => {
  const value = (outcome ?? "").toLowerCase();
  if (/dodelijk|overleden|fatal/.test(value)) return 3;
  if (/letsel|gewond|ziekenhuis|injury/.test(value)) return 2;
  return 1;
};

const haversineMeters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

async function fetchRoadPoints() {
  const all: RoadMetringPoint[] = [];
  let offset = 0;

  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      where: "a_n_nr LIKE 'A%'",
      outFields: "a_n_nr,l_r,hectometer,hectomtrng",
      returnGeometry: "true",
      geometry: `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outSR: "4326",
      resultOffset: String(offset),
      resultRecordCount: "2000",
      f: "geojson",
    });

    const response = await fetch(`${RWS_METERING}?${params}`, {
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(12_000),
      headers: { "user-agent": "StandbyRadar/0.8" },
    });
    if (!response.ok) throw new Error(`RWS metrering HTTP ${response.status}`);
    const json = await response.json() as { features?: unknown[] };
    all.push(...parseRoadMetringPoints(json));
    const count = json.features?.length ?? 0;
    if (count < 2000) break;
    offset += count;
  }

  return all;
}

async function fetchBronPage(offset: number) {
  const params = new URLSearchParams({
    where: "wegbeheerder = 'Rijk'",
    outFields: "jaar_ongeval,verkeersongeval_afloop,aard_ongeval,wegbeheerder",
    returnGeometry: "true",
    geometry: `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outSR: "4326",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    orderByFields: "objectid ASC",
    f: "geojson",
  });

  const response = await fetch(`${BRON_QUERY}?${params}`, {
    next: { revalidate: 86400 },
    signal: AbortSignal.timeout(12_000),
    headers: { "user-agent": "StandbyRadar/0.8" },
  });
  if (!response.ok) throw new Error(`RWS BRON HTTP ${response.status}`);
  return await response.json() as { features?: BronFeature[] };
}

function makeGrid(points: RoadMetringPoint[]) {
  const cell = 0.01;
  const key = (lat: number, lng: number) => `${Math.floor(lat / cell)}:${Math.floor(lng / cell)}`;
  const grid = new Map<string, RoadMetringPoint[]>();
  for (const point of points) {
    const k = key(point.lat, point.lng);
    const list = grid.get(k) ?? [];
    list.push(point);
    grid.set(k, list);
  }
  return { cell, key, grid };
}

function nearestRoadPoint(lat: number, lng: number, index: ReturnType<typeof makeGrid>) {
  const iy = Math.floor(lat / index.cell);
  const ix = Math.floor(lng / index.cell);
  let best: { point: RoadMetringPoint; distance: number } | null = null;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const point of index.grid.get(`${iy + dy}:${ix + dx}`) ?? []) {
        const distance = haversineMeters({ lat, lng }, point);
        if (distance > MAX_SNAP_METERS) continue;
        if (!best || distance < best.distance) best = { point, distance };
      }
    }
  }
  return best;
}

export async function GET() {
  try {
    const roadPoints = await fetchRoadPoints();
    const index = makeGrid(roadPoints);
    const grouped = new Map<string, {
      road: string;
      kmFrom: number;
      kmTo: number;
      accidents: number;
      weightedRisk: number;
      severe: number;
      years: Set<number>;
    }>();

    let totalRecords = 0;
    let mappedRecords = 0;

    for (let page = 0; page < 40; page++) {
      const json = await fetchBronPage(page * PAGE_SIZE);
      const features = json.features ?? [];
      totalRecords += features.length;

      for (const feature of features) {
        const coordinates = feature.geometry?.coordinates;
        if (!coordinates || typeof coordinates[0] !== "number" || typeof coordinates[1] !== "number") continue;
        const nearest = nearestRoadPoint(coordinates[1], coordinates[0], index);
        if (!nearest) continue;

        mappedRecords += 1;
        const road = nearest.point.road;
        const km = nearest.point.km;
        const kmFrom = Math.floor(km / 5) * 5;
        const kmTo = kmFrom + 5;
        const key = `${road}:${kmFrom}`;
        const current = grouped.get(key) ?? {
          road,
          kmFrom,
          kmTo,
          accidents: 0,
          weightedRisk: 0,
          severe: 0,
          years: new Set<number>(),
        };

        const props = feature.properties ?? {};
        const weight = severityWeight(props.verkeersongeval_afloop);
        const year = Number(props.jaar_ongeval);
        current.accidents += 1;
        current.weightedRisk += weight;
        if (weight >= 2) current.severe += 1;
        if (Number.isFinite(year)) current.years.add(year);
        grouped.set(key, current);
      }

      if (features.length < PAGE_SIZE) break;
    }

    const raw = [...grouped.values()];
    const maxWeighted = Math.max(1, ...raw.map(item => item.weightedRisk));
    const segments: HistoricalSegment[] = raw.map(item => ({
      id: `${item.road}-${item.kmFrom}-${item.kmTo}`,
      road: item.road,
      kmFrom: item.kmFrom,
      kmTo: item.kmTo,
      accidents: item.accidents,
      weightedRisk: item.weightedRisk,
      historyScore: Math.min(15, Math.round((Math.log1p(item.weightedRisk) / Math.log1p(maxWeighted)) * 15)),
      years: [...item.years].sort(),
      severe: item.severe,
    })).sort((a, b) => b.historyScore - a.historyScore || b.accidents - a.accidents);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      source: "Rijkswaterstaat BRON ongevallen 2022–2024 + officiële RWS A-wegmetrering",
      totalRecords,
      mappedRecords,
      segments,
      note: "Ongevalspunten zijn op coördinaat aan de dichtstbijzijnde officiële RWS A-wegmetrering gekoppeld. Historisch risico is begrensd op 0–15. BRON bevat geregistreerde ongevallen, niet alle pechgevallen of stilgevallen voertuigen.",
    }, { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400" } });
  } catch (error) {
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      source: "Rijkswaterstaat BRON ongevallen 2022–2024",
      totalRecords: 0,
      mappedRecords: 0,
      segments: [],
      error: error instanceof Error ? error.message : "Historische bron niet bereikbaar",
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
}
