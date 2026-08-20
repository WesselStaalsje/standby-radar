import { NextResponse } from "next/server";
import type { LiveRadarData, StandbyAdvice } from "@/lib/types";
import { GET as getLiveV7 } from "../live-v7/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DIRECT_TRAFFIC_FAMILIES = new Set(["physical", "fcd", "roadside", "external"]);
const SINGLE_EXTERNAL_RELIABILITY_CAP = 72;

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
    headers: { "user-agent": "StandbyRadar/2.2-operational" },
  });
  const response = await getLiveV7(delegated);
  if (!response.ok) return response;

  const data = await response.json() as LiveRadarData;
  return NextResponse.json(polishOperationalData(data), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
