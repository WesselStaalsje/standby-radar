import type { ConsensusSummary, FleetPlan, HistoricalBaseline, RoadDirection, SourceFamilyEvidence, StandbyAdvice } from "@/lib/types";

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const round = (value: number) => Math.round(value);

const pressureFromSpeed = (speed: number | null | undefined) => {
  if (speed === null || speed === undefined || !Number.isFinite(speed)) return null;
  if (speed < 30) return 100;
  if (speed < 45) return 88;
  if (speed < 60) return 72;
  if (speed < 75) return 55;
  if (speed < 90) return 35;
  if (speed < 105) return 15;
  return 0;
};

const sensorQuality = (advice: StandbyAdvice) => {
  if (typeof advice.sensorQualityScore === "number") return clamp(advice.sensorQualityScore);
  if (advice.sensorCount >= 5) return 82;
  if (advice.sensorCount >= 2) return 70;
  if (advice.sensorCount === 1) return 52;
  return 0;
};

const fcdQuality = (advice: StandbyAdvice) => {
  if (typeof advice.fcdQualityScore === "number") return clamp(advice.fcdQualityScore);
  if ((advice.travelTimeSampleCount ?? 0) >= 20) return 68;
  if ((advice.travelTimeSampleCount ?? 0) >= 5) return 55;
  return advice.fcdAverageSpeedKph !== null && advice.fcdAverageSpeedKph !== undefined ? 45 : 0;
};

export function consensusForAdvice(advice: StandbyAdvice): ConsensusSummary {
  const physicalPressure = advice.sensorCount > 0 ? clamp(advice.congestionIndex) : null;
  const fcdPressure = pressureFromSpeed(advice.fcdAverageSpeedKph);
  const roadsidePressure = advice.matrixClusters > 0 ? clamp(20 + advice.matrixClusters * 9 + advice.lowSpeedMatrixClusters * 6) : null;
  const incidentPressure = advice.localEvents > 0 ? clamp(advice.accidents * 45 + advice.obstructions * 25 + Math.max(0, advice.localEvents - advice.accidents - advice.obstructions) * 12) : null;
  const weatherPressure = advice.weather ? clamp((advice.weather.precipitation >= 2 ? 55 : advice.weather.precipitation >= .2 ? 25 : 0) + (advice.weather.visibility > 0 && advice.weather.visibility < 2000 ? 30 : advice.weather.visibility > 0 && advice.weather.visibility < 5000 ? 12 : 0) + (advice.weather.windGusts >= 70 ? 25 : advice.weather.windGusts >= 50 ? 10 : 0)) : null;
  const planningPressure = (advice.plannedEventCount ?? 0) > 0 ? clamp(25 + (advice.plannedEventCount ?? 0) * 12) : null;

  const evidence: SourceFamilyEvidence[] = [
    { family: "physical", available: physicalPressure !== null, pressure: physicalPressure, quality: sensorQuality(advice), weight: 1, detail: `${advice.sensorCount} fysieke meetpunten` },
    { family: "fcd", available: fcdPressure !== null, pressure: fcdPressure, quality: fcdQuality(advice), weight: .9, detail: `${advice.travelTimeSampleCount ?? 0} reistijd/FCD-metingen` },
    { family: "roadside", available: roadsidePressure !== null, pressure: roadsidePressure, quality: advice.matrixClusters > 0 ? 88 : 0, weight: .85, detail: `${advice.matrixClusters} matrixcluster(s)` },
    { family: "incident", available: incidentPressure !== null, pressure: incidentPressure, quality: advice.srtiConfirmed ? 95 : advice.localEvents > 0 ? 80 : 0, weight: .8, detail: `${advice.localEvents} actuele situaties` },
    { family: "weather", available: weatherPressure !== null, pressure: weatherPressure, quality: advice.weather ? 72 : 0, weight: .3, detail: advice.weather ? "actueel weer" : "geen weerdata" },
    { family: "planning", available: planningPressure !== null, pressure: planningPressure, quality: (advice.plannedEventCount ?? 0) > 0 ? 78 : 0, weight: .35, detail: `${advice.plannedEventCount ?? 0} geplande maatregel(en)` },
  ];

  const directTraffic = evidence.filter(item => ["physical", "fcd", "roadside"].includes(item.family) && item.available && item.pressure !== null && item.quality >= 35);
  const pressures = directTraffic.map(item => item.pressure as number);
  const spread = pressures.length >= 2 ? Math.max(...pressures) - Math.min(...pressures) : 0;
  const conflict = pressures.length >= 2 && spread >= 42;

  const scored = evidence.filter(item => item.available && item.pressure !== null && item.quality > 0);
  const totalWeight = scored.reduce((sum, item) => sum + item.weight * (item.quality / 100), 0);
  const score = totalWeight > 0 ? scored.reduce((sum, item) => sum + (item.pressure as number) * item.weight * (item.quality / 100), 0) / totalWeight : advice.congestionIndex;
  const independentFamilies = directTraffic.length;
  let reliability = scored.length ? scored.reduce((sum, item) => sum + item.quality * item.weight, 0) / scored.reduce((sum, item) => sum + item.weight, 0) : 20;
  reliability += Math.min(12, Math.max(0, independentFamilies - 1) * 6);
  if (conflict) reliability -= Math.min(35, 15 + spread * .35);
  if (advice.sensorCount === 0 && fcdPressure === null) reliability = Math.min(reliability, 38);

  return {
    score: round(clamp(score)),
    reliability: round(clamp(reliability)),
    conflict,
    spread: round(spread),
    agreeingFamilies: directTraffic.filter(item => Math.abs((item.pressure as number) - score) <= 22).length,
    evidence,
  };
}

export function baselineDeviation(advice: StandbyAdvice, baseline: HistoricalBaseline | null | undefined) {
  if (!baseline || !baseline.mature) return 0;
  let score = 0;
  if (advice.averageSpeedKph !== null && baseline.expectedSpeedKph !== null && baseline.expectedSpeedKph > 0) {
    const ratio = advice.averageSpeedKph / baseline.expectedSpeedKph;
    if (ratio < .45) score += 28;
    else if (ratio < .6) score += 20;
    else if (ratio < .75) score += 12;
    else if (ratio < .88) score += 5;
  }
  if (advice.flowVehiclesPerHour !== null && baseline.expectedFlowVehiclesPerHour !== null && baseline.expectedFlowVehiclesPerHour > 0) {
    const ratio = advice.flowVehiclesPerHour / baseline.expectedFlowVehiclesPerHour;
    if (ratio > 1.8) score += 12;
    else if (ratio > 1.45) score += 7;
    else if (ratio > 1.2) score += 3;
  }
  return Math.min(35, score);
}

export function incidentRiskForAdvice(advice: StandbyAdvice, historyScore = 0, baseline?: HistoricalBaseline | null) {
  const consensus = advice.consensus ?? consensusForAdvice(advice);
  const traffic = advice.trafficPressureScore ?? consensus.score;
  const baselineScore = baselineDeviation(advice, baseline);
  const eventScore = Math.min(38, advice.accidents * 24 + advice.obstructions * 12 + Math.max(0, advice.localEvents - advice.accidents - advice.obstructions) * 6);
  const matrixScore = Math.min(16, advice.matrixClusters * 3 + advice.lowSpeedMatrixClusters * 2);
  const weatherScore = advice.weather ? Math.min(14, (advice.weather.precipitation >= 2 ? 7 : advice.weather.precipitation >= .2 ? 3 : 0) + (advice.weather.visibility > 0 && advice.weather.visibility < 2000 ? 5 : advice.weather.visibility > 0 && advice.weather.visibility < 5000 ? 2 : 0) + (advice.weather.windGusts >= 70 ? 4 : advice.weather.windGusts >= 50 ? 2 : 0)) : 0;
  const plannedScore = Math.min(10, (advice.plannedEventCount ?? 0) * 4);
  const historical = Math.min(15, Math.max(0, historyScore));

  // Traffic pressure contributes to incident likelihood, but cannot by itself
  // create an extreme incident-risk score. Active incidents and road-side
  // measures remain the strongest near-term indicators.
  let risk30 = traffic * .26 + eventScore + matrixScore * .7 + weatherScore + plannedScore * .5 + historical * .45 + baselineScore * .45;
  let risk60 = traffic * .3 + eventScore * .8 + matrixScore * .6 + weatherScore + plannedScore + historical * .65 + baselineScore * .6;
  if (consensus.conflict) {
    risk30 *= .9;
    risk60 *= .92;
  }
  return {
    trafficPressureScore: round(clamp(traffic)),
    incidentRisk30: round(clamp(risk30)),
    incidentRisk60: round(clamp(risk60)),
    reliabilityScore: consensus.reliability,
    consensus,
  };
}

const sameDirection = (a: RoadDirection | undefined, b: RoadDirection | undefined) => !a || !b || a === b;
const roadDistance = (a: StandbyAdvice, b: StandbyAdvice) => a.road === b.road && sameDirection(a.direction, b.direction) ? Math.abs((a.kmFrom + a.kmTo) / 2 - (b.kmFrom + b.kmTo) / 2) : Infinity;

export function optimizeFleet(advice: StandbyAdvice[], units: number): FleetPlan {
  const count = Math.max(0, Math.min(20, Math.floor(units)));
  if (!count || !advice.length) return { requestedUnits: count, assignments: [], coveredRiskPercent: 0, uncoveredHighRiskSegments: advice.filter(item => (item.incidentRisk30 ?? 0) >= 65).map(item => item.id) };
  const risk = advice.map(item => ({ item, value: item.incidentRisk30 ?? item.score }));
  const totalRisk = risk.reduce((sum, row) => sum + row.value, 0) || 1;
  const covered = new Map<string, number>();
  const chosenStandbys = new Set<string>();
  const assignments: FleetPlan["assignments"] = [];

  for (let unit = 1; unit <= count; unit += 1) {
    let best: { advice: StandbyAdvice; marginal: number; coveredRisk: number } | null = null;
    for (const candidate of advice) {
      if (chosenStandbys.has(candidate.standby.id)) continue;
      let marginal = 0;
      let candidateCoverage = 0;
      for (const target of risk) {
        const distance = roadDistance(candidate, target.item);
        const reach = distance <= 5 ? 1 : distance <= 10 ? .72 : distance <= 15 ? .42 : candidate.id === target.item.id ? 1 : 0;
        if (reach <= 0) continue;
        const contribution = target.value * reach;
        candidateCoverage += contribution;
        marginal += Math.max(0, contribution - (covered.get(target.item.id) ?? 0));
      }
      const reliabilityFactor = (candidate.reliabilityScore ?? 50) / 100;
      const routeFactor = candidate.routeVerified === false ? .82 : 1;
      marginal *= .75 + reliabilityFactor * .25;
      marginal *= routeFactor;
      if (!best || marginal > best.marginal) best = { advice: candidate, marginal, coveredRisk: candidateCoverage };
    }
    if (!best || best.marginal <= 0) break;
    chosenStandbys.add(best.advice.standby.id);
    for (const target of risk) {
      const distance = roadDistance(best.advice, target.item);
      const reach = distance <= 5 ? 1 : distance <= 10 ? .72 : distance <= 15 ? .42 : best.advice.id === target.item.id ? 1 : 0;
      if (reach > 0) covered.set(target.item.id, Math.max(covered.get(target.item.id) ?? 0, target.value * reach));
    }
    assignments.push({
      unit,
      adviceId: best.advice.id,
      standbyId: best.advice.standby.id,
      standbyName: best.advice.standby.name,
      road: best.advice.road,
      direction: best.advice.direction ?? null,
      coveredRisk: round(best.coveredRisk),
      marginalCoverage: round(best.marginal),
      etaMinutes: best.advice.routeEtaMinutes ?? best.advice.standby.routeEtaMinutes ?? null,
    });
  }

  const coveredRisk = [...covered.values()].reduce((sum, value) => sum + value, 0);
  const uncoveredHighRiskSegments = risk.filter(row => row.value >= 65 && (covered.get(row.item.id) ?? 0) < row.value * .5).map(row => row.item.id);
  return {
    requestedUnits: count,
    assignments,
    coveredRiskPercent: round(clamp(coveredRisk / totalRisk * 100)),
    uncoveredHighRiskSegments,
  };
}
