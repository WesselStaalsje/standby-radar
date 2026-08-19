import { NextResponse } from "next/server";
import { GET as getBaseLive } from "../live/route";
import type { LiveRadarData, StandbyAdvice } from "@/lib/types";
import { fetchTomTomRelativeFlow, scoreTomTom, type TomTomFlowSample } from "@/lib/tomtom";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Point = { id: string; lat: number; lng: number };

type Overlay = LiveRadarData["rayons"]["roadOverlays"][number];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function distanceKm(a: [number, number], b: [number, number]) {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function pointAlongOverlay(overlay: Overlay, km: number): { lat: number; lng: number } | null {
  const coordinates = overlay.coordinates;
  if (!coordinates.length) return null;
  if (coordinates.length === 1 || overlay.toKm <= overlay.fromKm) return { lat: coordinates[0][0], lng: coordinates[0][1] };

  const fraction = clamp((km - overlay.fromKm) / (overlay.toKm - overlay.fromKm), 0, 1);
  const distances: number[] = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const d = distanceKm(coordinates[i - 1], coordinates[i]);
    distances.push(d);
    total += d;
  }
  if (!total) return { lat: coordinates[0][0], lng: coordinates[0][1] };

  const target = total * fraction;
  let traversed = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const leg = distances[i - 1];
    if (traversed + leg >= target) {
      const t = leg ? (target - traversed) / leg : 0;
      const a = coordinates[i - 1];
      const b = coordinates[i];
      return { lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t };
    }
    traversed += leg;
  }

  const last = coordinates[coordinates.length - 1];
  return { lat: last[0], lng: last[1] };
}

function pointForAdvice(advice: StandbyAdvice, overlays: Overlay[]): Point {
  const centerKm = (advice.kmFrom + advice.kmTo) / 2;
  const matching = overlays
    .filter(overlay => overlay.road === advice.road && overlay.rayon === advice.rayon && centerKm >= overlay.fromKm - 0.2 && centerKm <= overlay.toKm + 0.2)
    .sort((a, b) => Math.abs(((a.fromKm + a.toKm) / 2) - centerKm) - Math.abs(((b.fromKm + b.toKm) / 2) - centerKm));
  const point = matching.length ? pointAlongOverlay(matching[0], centerKm) : null;
  return point
    ? { id: advice.id, lat: point.lat, lng: point.lng }
    : { id: advice.id, lat: advice.standby.lat, lng: advice.standby.lng };
}

function tomTomReason(sample: TomTomFlowSample) {
  const percentage = Math.round(sample.relativeSpeed * 100);
  if (sample.roadClosure) return `TomTom Traffic: wegsegment als gesloten / nagenoeg stil gemeten (${sample.distanceMeters} m matchafstand)`;
  if (sample.relativeSpeed <= 0.60) return `TomTom Traffic: verkeer rijdt circa ${percentage}% van normale vrije doorstroming (${sample.distanceMeters} m matchafstand)`;
  if (sample.relativeSpeed <= 0.85) return `TomTom Traffic: merkbare vertraging, circa ${percentage}% van free-flow (${sample.distanceMeters} m matchafstand)`;
  return `TomTom Traffic: circa ${percentage}% van normale vrije doorstroming (${sample.distanceMeters} m matchafstand)`;
}

function enhanceAdvice(advice: StandbyAdvice, sample: TomTomFlowSample | undefined): StandbyAdvice {
  if (!sample) return advice;

  const ttScore = scoreTomTom(sample.relativeSpeed, sample.roadClosure);
  const tomTomCongested = sample.roadClosure || sample.relativeSpeed <= 0.85;
  let score = advice.score;
  let corroboratingSignals = advice.corroboratingSignals;
  let confidence = advice.confidence;
  const reasons = [...advice.reasons, tomTomReason(sample)];

  if (advice.sensorCount === 0) {
    // TomTom fills the missing traffic-flow component; matrix/incidents/weather remain independent additions.
    score = clamp(advice.score + ttScore, 0, 96);
    if (tomTomCongested) corroboratingSignals = clamp(advice.corroboratingSignals + 1, 0, 4);

    const independentSupport = advice.matrixClusters > 0 || advice.localEvents > 0;
    if (tomTomCongested && independentSupport) confidence = "hoog";
    else if (sample.distanceMeters <= 500) confidence = "middel";

    reasons.push("Geen fysieke NDW-detector: TomTom vult hier de live verkeersdrukcomponent in; het wegdeel wordt dus niet lager gewaardeerd door ontbrekende lussen.");
  } else {
    const ndwCongested = advice.congestionIndex >= 25;
    if (tomTomCongested && ndwCongested) {
      score = clamp(advice.score + Math.min(6, Math.max(2, Math.round(ttScore / 6))), 0, 96);
      reasons.push("TomTom en fysieke NDW-detectoren bevestigen onafhankelijk hetzelfde vertragingsbeeld.");
    } else if (tomTomCongested && !ndwCongested) {
      reasons.push("TomTom ziet meer vertraging dan de fysieke detectoren; daarom alleen als controlemelding gebruikt en niet dubbel bij de score opgeteld.");
    } else if (!tomTomCongested && ndwCongested) {
      reasons.push("NDW meet vertraging terwijl TomTom vrijwel vrije doorstroming ziet; score blijft conservatief op de fysieke detector gebaseerd.");
    }
  }

  const pressure: StandbyAdvice["pressure"] = score >= 65 ? "hoog" : score >= 38 ? "verhoogd" : "rustig";
  const recommendedUnits = score >= 72 && confidence !== "laag" ? 2 : score >= 38 ? 1 : 0;

  return {
    ...advice,
    score,
    pressure,
    confidence,
    recommendedUnits,
    corroboratingSignals,
    congestionIndex: advice.sensorCount === 0 ? Math.max(advice.congestionIndex, sample.congestionIndex) : advice.congestionIndex,
    reasons,
  };
}

export async function GET() {
  const baseResponse = await getBaseLive();
  const base = await baseResponse.json() as LiveRadarData;
  const points = base.advice.map(advice => pointForAdvice(advice, base.rayons.roadOverlays));
  const tomtom = await fetchTomTomRelativeFlow(points, process.env.TOMTOM_API_KEY);

  const advice = base.advice
    .map(item => enhanceAdvice(item, tomtom.samples.get(item.id)))
    .sort((a, b) => b.score - a.score || b.corroboratingSignals - a.corroboratingSignals || a.road.localeCompare(b.road, "nl", { numeric: true }));

  const source = {
    id: "tomtom-flow",
    name: "TomTom live verkeersflow",
    ok: tomtom.configured && tomtom.samples.size > 0,
    updatedAt: tomtom.updatedAt,
    error: tomtom.configured ? tomtom.error ?? (tomtom.samples.size ? null : "Geen TomTom-match binnen het werkgebied") : "API-key nog niet gekoppeld",
    lineage: "TomTom Traffic vector flow · relatieve snelheid t.o.v. free-flow · 5 minuten cache",
  };

  const note = tomtom.configured
    ? `${base.meta.note} TomTom Traffic is aanvullend gekoppeld via quota-efficiënte vector flow tiles; ${tomtom.samples.size}/${base.advice.length} berekende wegvakken hebben een TomTom-flowmatch. Zonder fysieke detector mag TomTom de ontbrekende verkeersdrukcomponent invullen; met detector dient TomTom vooral als onafhankelijke bevestiging.`
    : `${base.meta.note} TomTom-integratie is technisch gereed maar wacht op TOMTOM_API_KEY in Vercel. Tot die tijd blijft de bestaande NDW/RWS-analyse volledig functioneren.`;

  return NextResponse.json({
    ...base,
    advice,
    sources: [...base.sources.filter(item => item.id !== "tomtom-flow"), source],
    meta: {
      ...base.meta,
      modelVersion: "0.9-tomtom-fusion",
      tomtomConfigured: tomtom.configured,
      tomtomCoverageSegments: tomtom.samples.size,
      tomtomTileCount: tomtom.tileCount,
      note,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
