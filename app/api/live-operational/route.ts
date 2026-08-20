import { NextResponse } from "next/server";
import type { LiveRadarData, StandbyAdvice, TrafficEvent } from "@/lib/types";
import { fetchTomTomBrokenDownVehicles } from "@/lib/tomtom-incidents";
import { GET as getLiveV7 } from "../live-v7/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DIRECT_TRAFFIC_FAMILIES = new Set(["physical", "fcd", "roadside", "external"]);
const SINGLE_EXTERNAL_RELIABILITY_CAP = 72;
const TOMTOM_DEDUPE_METERS = 500;

const rad = (value: number) => value * Math.PI / 180;

function distanceMeters(a: Pick<TrafficEvent, "lat" | "lng">, b: Pick<TrafficEvent, "lat" | "lng">) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function newestTimestamp(a: string | null, b: string | null) {
  const aTime = a ? Date.parse(a) : NaN;
  const bTime = b ? Date.parse(b) : NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime >= bTime ? a : b;
  return a ?? b;
}

function mergeBrokenDownVehicles(base: TrafficEvent[], tomtomEvents: TrafficEvent[]) {
  const events = base.map(item => ({ ...item }));
  const alreadyMatched = new Set<number>();
  let confirmed = 0;
  let added = 0;

  for (const tomtom of tomtomEvents) {
    let best: { index: number; distance: number } | null = null;
    for (let index = 0; index < events.length; index += 1) {
      if (alreadyMatched.has(index)) continue;
      const existing = events[index];
      if (existing.kind !== "obstruction" || existing.type !== "VehicleObstruction") continue;
      if (!existing.roadRef || existing.roadRef !== tomtom.roadRef) continue;
      const distance = distanceMeters(existing, tomtom);
      if (distance > TOMTOM_DEDUPE_METERS) continue;
      if (!best || distance < best.distance) best = { index, distance };
    }

    if (!best) {
      events.push(tomtom);
      added += 1;
      continue;
    }

    alreadyMatched.add(best.index);
    const existing = events[best.index];
    const sources = [...new Set([existing.source, "TomTom Traffic"].filter((value): value is string => Boolean(value)))];
    events[best.index] = {
      ...existing,
      title: "Stilstaand / defect voertuig",
      type: "VehicleObstruction+TomTomBrokenDownVehicle",
      source: sources.join(" + "),
      updatedAt: newestTimestamp(existing.updatedAt, tomtom.updatedAt),
      direction: existing.direction ?? tomtom.direction ?? null,
      roadKm: existing.roadKm ?? tomtom.roadKm ?? null,
      rayon: existing.rayon ?? tomtom.rayon ?? null,
      startsAt: existing.startsAt ?? tomtom.startsAt ?? null,
      endsAt: existing.endsAt ?? tomtom.endsAt ?? null,
    };
    confirmed += 1;
  }

  return { events, confirmed, added };
}

function calibrateSingleSourceConfidence(advice: StandbyAdvice): StandbyAdvice {
  const consensus = advice.consensus;
  if (!consensus) return advice;

  const directTraffic = consensus.evidence.filter(item =>
    DIRECT_TRAFFIC_FAMILIES.has(item.family)
    && item.available
    && item.pressure !== null
    && item.quality >= 35,
  );

  // One excellent provider is useful, but it is still only one independent
  // traffic observation. Do not present TomTom-only coverage as high certainty.
  if (directTraffic.length !== 1 || directTraffic[0].family !== "external") return advice;

  const reliability = Math.min(
    SINGLE_EXTERNAL_RELIABILITY_CAP,
    advice.reliabilityScore ?? consensus.reliability,
    consensus.reliability,
  );
  const reason = "TomTom is hier de enige directe actuele verkeersbron; betrouwbaarheid is daarom bewust begrensd totdat een tweede verkeersbron bevestigt.";

  return {
    ...advice,
    confidence: advice.confidence === "hoog" ? "middel" : advice.confidence,
    reliabilityScore: reliability,
    consensus: { ...consensus, reliability },
    reasons: advice.reasons.includes(reason) ? advice.reasons : [...advice.reasons, reason],
  };
}

function polishOperationalData(data: LiveRadarData): LiveRadarData {
  const advice = data.advice.map(calibrateSingleSourceConfidence);
  const staleDatabaseText = "Eigen kwartierbaselines en replay/backtests groeien zodra de beveiligde Standby Radar-databasevariabele in Vercel is gekoppeld.";
  const currentDatabaseText = "Eigen kwartierbaselines groeien voor alle directionele contractsegmenten; replay/backtests worden vrijgegeven zodra genoeg historie en incidentuitkomsten zijn opgebouwd.";

  return {
    ...data,
    advice,
    meta: {
      ...data.meta,
      note: data.meta.note.replace(staleDatabaseText, currentDatabaseText),
      consensusConflictCount: advice.filter(item => item.consensus?.conflict).length,
    },
  };
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const upstreamOrigin = productionHost
    ? `https://${productionHost.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : requestUrl.origin;

  // live-v7 isolates the heavy v6 refresh over HTTP. On authenticated Vercel
  // previews, an internal request to the preview hostname is intercepted by
  // Deployment Protection. Point its upstream at the public production host so
  // previews exercise the new enrichment/runtime layer against a real v6 feed.
  const delegated = new Request(`${upstreamOrigin}/api/live-operational`, {
    method: "GET",
    headers: { "user-agent": "StandbyRadar/2.3-operational" },
  });
  const response = await getLiveV7(delegated);
  if (!response.ok) return response;

  const data = polishOperationalData(await response.json() as LiveRadarData);
  let brokenDown;
  try {
    brokenDown = await fetchTomTomBrokenDownVehicles(data.rayons.roadOverlays, process.env.TOMTOM_API_KEY);
  } catch (error) {
    brokenDown = {
      configured: Boolean(process.env.TOMTOM_API_KEY),
      updatedAt: null,
      events: [],
      rawCount: 0,
      matchedCount: 0,
      successfulBoxes: 0,
      error: error instanceof Error ? error.message : "TomTom incidentfeed niet bereikbaar",
    };
  }

  const merged = mergeBrokenDownVehicles(data.events, brokenDown.events);
  const sources = [
    ...data.sources.filter(source => source.id !== "tomtom-incidents"),
    {
      id: "tomtom-incidents",
      name: "TomTom stilstaande/defecte voertuigen",
      ok: brokenDown.configured && brokenDown.successfulBoxes > 0,
      updatedAt: brokenDown.updatedAt,
      error: brokenDown.configured ? brokenDown.error : "TOMTOM_API_KEY ontbreekt",
      lineage: `TomTom Traffic Incident Details v5 · BrokenDownVehicle · ${brokenDown.matchedCount}/${brokenDown.rawCount} incident(en) binnen operationele IM-weggeometrie`,
    },
  ];

  return NextResponse.json({
    ...data,
    events: merged.events,
    sources,
    meta: {
      ...data.meta,
      eventCount: merged.events.length,
      obstructionCount: merged.events.filter(event => event.kind === "obstruction").length,
      modelVersion: "2.3-tomtom-broken-down-vehicles",
      note: `${data.meta.note} TomTom Incident Details v5 voegt actuele stilstaande/defecte voertuigen toe aan de kaart; overlap met NDW VehicleObstruction wordt binnen 500 meter samengevoegd in plaats van dubbel getoond.`,
    },
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
