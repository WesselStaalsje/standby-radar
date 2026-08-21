import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POINTS = [
  { name: "Arnhem", lat: 51.9851, lon: 5.8987 },
  { name: "Elst", lat: 51.9198, lon: 5.8415 },
  { name: "Nijmegen", lat: 51.8426, lon: 5.8528 },
];
const SEARCHES = [
  { query: "parking", categories: "7369,7313" },
  { query: "rest area", categories: "7395,7358" },
  { query: "petrol station", categories: "7311" },
  { query: "P+R", categories: "7369,7313" },
];

export async function GET() {
  const key = process.env.TOMTOM_API_KEY;
  if (!key) return NextResponse.json({ error: "TomTom key ontbreekt" }, { status: 503 });
  const out: unknown[] = [];
  for (const point of POINTS) {
    for (const search of SEARCHES) {
      const params = new URLSearchParams({ key, lat: String(point.lat), lon: String(point.lon), radius: "14000", limit: "20", countrySet: "NL", idxSet: "POI", categorySet: search.categories });
      const response = await fetch(`https://api.tomtom.com/search/2/search/${encodeURIComponent(search.query)}.json?${params}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const json = response.ok ? await response.json() : null;
      const results = (json?.results ?? []).map((result: any) => ({
        id: result.id,
        name: result.poi?.name,
        categories: result.poi?.categories,
        categorySet: result.poi?.categorySet,
        lat: result.position?.lat,
        lon: result.position?.lon,
        address: result.address?.freeformAddress,
        dist: result.dist,
      }));
      out.push({ point: point.name, query: search.query, status: response.status, count: results.length, results });
    }
  }
  return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
}
