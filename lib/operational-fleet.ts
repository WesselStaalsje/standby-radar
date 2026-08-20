import type { FleetPlan, RoadDirection, StandbyAdvice } from "@/lib/types";

const MAX_OPERATIONAL_ETA_MINUTES = 12;
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const round = (value: number) => Math.round(value);
const sameDirection = (a: RoadDirection | undefined, b: RoadDirection | undefined) => !a || !b || a === b;
const roadDistance = (a: StandbyAdvice, b: StandbyAdvice) => a.road === b.road && sameDirection(a.direction, b.direction)
  ? Math.abs((a.kmFrom + a.kmTo) / 2 - (b.kmFrom + b.kmTo) / 2)
  : Infinity;

function routeEta(advice: StandbyAdvice) {
  return advice.routeEtaMinutes ?? advice.standby.routeEtaMinutes ?? null;
}

function operationalCandidate(advice: StandbyAdvice) {
  const eta = routeEta(advice);
  if (advice.routeVerified === false) return false;
  if (eta === null || !Number.isFinite(eta)) return false;
  return eta <= MAX_OPERATIONAL_ETA_MINUTES;
}

function reach(candidate: StandbyAdvice, target: StandbyAdvice) {
  const distance = roadDistance(candidate, target);
  if (distance <= 5) return 1;
  if (distance <= 10) return .72;
  if (distance <= 15) return .42;
  return candidate.id === target.id ? 1 : 0;
}

export function optimizeOperationalFleet(advice: StandbyAdvice[], units: number): FleetPlan {
  const count = Math.max(0, Math.min(20, Math.floor(units)));
  const risk = advice.map(item => ({ item, value: item.incidentRisk30 ?? item.score }));
  const totalRisk = risk.reduce((sum, row) => sum + row.value, 0) || 1;
  const candidates = advice.filter(operationalCandidate);

  if (!count || !advice.length || !candidates.length) {
    return {
      requestedUnits: count,
      assignments: [],
      coveredRiskPercent: 0,
      uncoveredHighRiskSegments: risk.filter(row => row.value >= 65).map(row => row.item.id),
    };
  }

  const covered = new Map<string, number>();
  const chosenStandbys = new Set<string>();
  const assignments: FleetPlan["assignments"] = [];

  for (let unit = 1; unit <= count; unit += 1) {
    let best: { advice: StandbyAdvice; marginal: number; coveredRisk: number } | null = null;

    for (const candidate of candidates) {
      if (chosenStandbys.has(candidate.standby.id)) continue;

      let marginal = 0;
      let candidateCoverage = 0;
      for (const target of risk) {
        const coverage = reach(candidate, target.item);
        if (coverage <= 0) continue;
        const contribution = target.value * coverage;
        candidateCoverage += contribution;
        marginal += Math.max(0, contribution - (covered.get(target.item.id) ?? 0));
      }

      const reliabilityFactor = clamp(candidate.reliabilityScore ?? 50) / 100;
      const eta = routeEta(candidate) ?? MAX_OPERATIONAL_ETA_MINUTES;
      // A 1-minute verified access point should beat an otherwise equivalent
      // 10-12 minute repositioning candidate. The penalty stays mild enough
      // that a genuinely high-risk corridor can still justify a longer move.
      const etaFactor = clamp(1 - Math.max(0, eta - 2) * .035, .65, 1);
      marginal *= .75 + reliabilityFactor * .25;
      marginal *= etaFactor;

      if (!best || marginal > best.marginal) {
        best = { advice: candidate, marginal, coveredRisk: candidateCoverage };
      }
    }

    if (!best || best.marginal <= 0) break;
    chosenStandbys.add(best.advice.standby.id);

    for (const target of risk) {
      const coverage = reach(best.advice, target.item);
      if (coverage > 0) {
        covered.set(target.item.id, Math.max(covered.get(target.item.id) ?? 0, target.value * coverage));
      }
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
      etaMinutes: routeEta(best.advice),
    });
  }

  const coveredRisk = [...covered.values()].reduce((sum, value) => sum + value, 0);
  const uncoveredHighRiskSegments = risk
    .filter(row => row.value >= 65 && (covered.get(row.item.id) ?? 0) < row.value * .5)
    .map(row => row.item.id);

  return {
    requestedUnits: count,
    assignments,
    coveredRiskPercent: round(clamp(coveredRisk / totalRisk * 100)),
    uncoveredHighRiskSegments,
  };
}

export const OPERATIONAL_FLEET_MAX_ETA_MINUTES = MAX_OPERATIONAL_ETA_MINUTES;
