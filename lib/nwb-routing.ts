import type { RoadDirection } from "@/lib/types";

export const NWB_WEGVAKKEN_URL = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/nwb_wegen/MapServer/2/query";

export type NwbRoadEdge = {
  wvkId: number;
  beginJunction: number;
  endJunction: number;
  road: string | null;
  relativePosition: string | null;
  administrativeDirection: string | null;
  trafficDirection: "H" | "T" | "B" | "O";
  lengthKm: number;
  coordinates: Array<[number, number]>;
};

export type NwbRouteResult = {
  reachable: boolean;
  distanceKm: number | null;
  etaMinutes: number | null;
  wvkPath: number[];
  visitedNodes: number;
};

type GeoFeature = {
  geometry?: { coordinates?: unknown };
  properties?: Record<string, unknown>;
};

type Arc = { to: number; wvkId: number; distanceKm: number };
type Endpoint = { node: number; extraKm: number };

const rad = (value: number) => value * Math.PI / 180;
const haversineKm = (a: [number, number], b: [number, number]) => {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

const normalizeRoad = (value: unknown) => {
  const match = /\bA\s*0*(\d{1,3})\b/i.exec(String(value ?? ""));
  return match ? `A${Number(match[1])}` : null;
};

const lineCoordinates = (geometry: GeoFeature["geometry"]): Array<[number, number]> => {
  const raw = geometry?.coordinates;
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      out.push([value[0], value[1]]);
      return;
    }
    value.forEach(walk);
  };
  walk(raw);
  return out;
};

const lineLengthKm = (coordinates: Array<[number, number]>) => {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) total += haversineKm(coordinates[index - 1], coordinates[index]);
  return total;
};

export function parseNwbRoadEdges(payload: unknown): NwbRoadEdge[] {
  const features = (payload as { features?: GeoFeature[] })?.features ?? [];
  const out: NwbRoadEdge[] = [];
  for (const feature of features) {
    const properties = feature.properties ?? {};
    const wvkId = Number(properties.wvk_id);
    const beginJunction = Number(properties.jte_id_beg);
    const endJunction = Number(properties.jte_id_end);
    if (!Number.isFinite(wvkId) || !Number.isFinite(beginJunction) || !Number.isFinite(endJunction)) continue;
    const coordinates = lineCoordinates(feature.geometry);
    if (coordinates.length < 2) continue;
    const lengthKm = lineLengthKm(coordinates);
    if (!Number.isFinite(lengthKm) || lengthKm <= 0 || lengthKm > 50) continue;
    const rawDirection = String(properties.rijrichtng ?? "O").toUpperCase();
    const trafficDirection: NwbRoadEdge["trafficDirection"] = rawDirection === "H" || rawDirection === "T" || rawDirection === "B" ? rawDirection : "O";
    out.push({
      wvkId,
      beginJunction,
      endJunction,
      road: normalizeRoad(properties.wegnummer),
      relativePosition: typeof properties.rpe_code === "string" ? properties.rpe_code : null,
      administrativeDirection: typeof properties.admrichtng === "string" ? properties.admrichtng : null,
      trafficDirection,
      lengthKm,
      coordinates,
    });
  }
  return out;
}

export class NwbRoutingGraph {
  private readonly edges = new Map<number, NwbRoadEdge>();
  private readonly adjacency = new Map<number, Arc[]>();

  constructor(edges: NwbRoadEdge[]) {
    for (const edge of edges) {
      this.edges.set(edge.wvkId, edge);
      const add = (from: number, to: number) => {
        const list = this.adjacency.get(from) ?? [];
        list.push({ to, wvkId: edge.wvkId, distanceKm: edge.lengthKm });
        this.adjacency.set(from, list);
      };
      // NWB: H = begin -> end, T = end -> begin, B = both.
      if (edge.trafficDirection === "H" || edge.trafficDirection === "B") add(edge.beginJunction, edge.endJunction);
      if (edge.trafficDirection === "T" || edge.trafficDirection === "B") add(edge.endJunction, edge.beginJunction);
      // Unknown is deliberately not routed: reliability wins over optimistic reachability.
    }
  }

  get size() { return this.edges.size; }

  hasWvk(wvkId: number | null | undefined) {
    return typeof wvkId === "number" && this.edges.has(wvkId);
  }

  private departures(edge: NwbRoadEdge): Endpoint[] {
    const half = edge.lengthKm / 2;
    if (edge.trafficDirection === "H") return [{ node: edge.endJunction, extraKm: half }];
    if (edge.trafficDirection === "T") return [{ node: edge.beginJunction, extraKm: half }];
    if (edge.trafficDirection === "B") return [{ node: edge.beginJunction, extraKm: half }, { node: edge.endJunction, extraKm: half }];
    return [];
  }

  private arrivals(edge: NwbRoadEdge): Endpoint[] {
    const half = edge.lengthKm / 2;
    if (edge.trafficDirection === "H") return [{ node: edge.beginJunction, extraKm: half }];
    if (edge.trafficDirection === "T") return [{ node: edge.endJunction, extraKm: half }];
    if (edge.trafficDirection === "B") return [{ node: edge.beginJunction, extraKm: half }, { node: edge.endJunction, extraKm: half }];
    return [];
  }

  route(fromWvkId: number, toWvkId: number, maxDistanceKm = 80): NwbRouteResult {
    const from = this.edges.get(fromWvkId);
    const to = this.edges.get(toWvkId);
    if (!from || !to) return { reachable: false, distanceKm: null, etaMinutes: null, wvkPath: [], visitedNodes: 0 };
    if (fromWvkId === toWvkId) {
      const distanceKm = Math.max(.05, from.lengthKm * .25);
      return { reachable: true, distanceKm: Math.round(distanceKm * 10) / 10, etaMinutes: Math.round((distanceKm / 90 * 60 + 1) * 10) / 10, wvkPath: [fromWvkId], visitedNodes: 1 };
    }
    const starts = this.departures(from);
    const targets = this.arrivals(to);
    if (!starts.length || !targets.length) return { reachable: false, distanceKm: null, etaMinutes: null, wvkPath: [], visitedNodes: 0 };

    const targetExtra = new Map<number, number>();
    for (const target of targets) targetExtra.set(target.node, Math.min(target.extraKm, targetExtra.get(target.node) ?? Infinity));
    const distance = new Map<number, number>();
    const previous = new Map<number, { node: number; wvkId: number }>();
    const queue: Array<{ node: number; distanceKm: number }> = [];
    for (const start of starts) {
      const old = distance.get(start.node) ?? Infinity;
      if (start.extraKm < old) {
        distance.set(start.node, start.extraKm);
        queue.push({ node: start.node, distanceKm: start.extraKm });
      }
    }

    let bestTarget: { node: number; distanceKm: number } | null = null;
    let visitedNodes = 0;
    while (queue.length) {
      queue.sort((a, b) => a.distanceKm - b.distanceKm);
      const current = queue.shift()!;
      if (current.distanceKm !== distance.get(current.node)) continue;
      if (current.distanceKm > maxDistanceKm) break;
      visitedNodes += 1;
      const arrivalExtra = targetExtra.get(current.node);
      if (arrivalExtra !== undefined) {
        const total = current.distanceKm + arrivalExtra;
        if (!bestTarget || total < bestTarget.distanceKm) bestTarget = { node: current.node, distanceKm: total };
        if (queue[0] && queue[0].distanceKm >= total) break;
      }
      for (const arc of this.adjacency.get(current.node) ?? []) {
        const nextDistance = current.distanceKm + arc.distanceKm;
        if (nextDistance > maxDistanceKm || nextDistance >= (distance.get(arc.to) ?? Infinity)) continue;
        distance.set(arc.to, nextDistance);
        previous.set(arc.to, { node: current.node, wvkId: arc.wvkId });
        queue.push({ node: arc.to, distanceKm: nextDistance });
      }
    }
    if (!bestTarget) return { reachable: false, distanceKm: null, etaMinutes: null, wvkPath: [], visitedNodes };

    const path: number[] = [toWvkId];
    let cursor = bestTarget.node;
    while (previous.has(cursor)) {
      const step = previous.get(cursor)!;
      path.push(step.wvkId);
      cursor = step.node;
      if (path.length > 2000) break;
    }
    path.push(fromWvkId);
    path.reverse();
    const distanceKm = Math.round(bestTarget.distanceKm * 10) / 10;
    // Conservative operational ETA: motorway graph distance at 90 km/h plus
    // 90 seconds for leaving/entering the standby position.
    const etaMinutes = Math.round((distanceKm / 90 * 60 + 1.5) * 10) / 10;
    return { reachable: true, distanceKm, etaMinutes, wvkPath: [...new Set(path)], visitedNodes };
  }
}

export function directionFromRelativePosition(relativePosition: string | null | undefined): RoadDirection {
  const value = String(relativePosition ?? "").toUpperCase();
  if (value === "L") return "Li";
  if (value === "R") return "Re";
  return null;
}
