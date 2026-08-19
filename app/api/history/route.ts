import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BRON_QUERY = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/verkeersongevallen_nederland/FeatureServer/3/query";
const BBOX = { minLat: 51.15, minLng: 4.20, maxLat: 52.30, maxLng: 6.55 };
const PAGE_SIZE = 1000;

type BronFeature = {
  properties?: {
    jaar_ongeval?: number | null;
    hectometer?: number | null;
    straatnaam?: string | null;
    verkeersongeval_afloop?: string | null;
    aard_ongeval?: string | null;
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

const normalizeRoad = (value: unknown) => {
  const match = /\bA\s*0*(\d{1,3})\b/i.exec(String(value ?? ""));
  return match ? `A${Number(match[1])}` : null;
};

const severityWeight = (outcome: string | null | undefined) => {
  const value = (outcome ?? "").toLowerCase();
  if (/dodelijk|overleden|fatal/.test(value)) return 3;
  if (/letsel|gewond|ziekenhuis|injury/.test(value)) return 2;
  return 1;
};

async function fetchPage(offset: number) {
  const params = new URLSearchParams({
    where: "straatnaam LIKE 'A%'",
    outFields: "jaar_ongeval,hectometer,straatnaam,verkeersongeval_afloop,aard_ongeval",
    returnGeometry: "false",
    geometry: `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
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

export async function GET() {
  try {
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
    for (let page = 0; page < 30; page++) {
      const json = await fetchPage(page * PAGE_SIZE);
      const features = json.features ?? [];
      totalRecords += features.length;

      for (const feature of features) {
        const props = feature.properties ?? {};
        const road = normalizeRoad(props.straatnaam);
        const km = Number(props.hectometer);
        const year = Number(props.jaar_ongeval);
        if (!road || !Number.isFinite(km) || km < 0 || km > 400) continue;

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

        const weight = severityWeight(props.verkeersongeval_afloop);
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
      source: "Rijkswaterstaat BRON ongevallen 2022–2024",
      totalRecords,
      segments,
      note: "Historische component is bewust begrensd op 0–15 punten. Deze dataset betreft geregistreerde ongevallen, niet alle pechgevallen of stilgevallen voertuigen.",
    }, { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400" } });
  } catch (error) {
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      source: "Rijkswaterstaat BRON ongevallen 2022–2024",
      totalRecords: 0,
      segments: [],
      error: error instanceof Error ? error.message : "Historische bron niet bereikbaar",
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
}
