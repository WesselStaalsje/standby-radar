"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap, TileLayer } from "leaflet";
import type { LiveRadarData, StandbyAdvice, TrafficEvent, TrafficKind } from "@/lib/types";

type Filters = { traffic: boolean; incidents: boolean; works: boolean; advice: boolean };
type HistoricalSegment = { id: string; road: string; kmFrom: number; kmTo: number; accidents: number; weightedRisk: number; historyScore: number; years: number[]; severe: number };
type HistoryData = { generatedAt: string; source: string; totalRecords: number; mappedRecords?: number; segments: HistoricalSegment[]; note?: string; error?: string };
type HistoryMatch = { accidents: number; score: number; severe: number; years: number[] };
type StabilityState = {
  loaded: boolean;
  advice: StandbyAdvice[];
  since: number;
  pendingSignature: string | null;
  pendingSince: number | null;
};
type EventMarkerType = "breakdown" | "accident" | "obstruction" | "traffic" | "works" | "closure" | "weather";
type EventCluster = { events: TrafficEvent[]; lat: number; lng: number; roadRef: string | null };
type RegionalWatch = { id: string; name: string; lat: number; lng: number; radiusKm: number; roads: string[] };

const STANDBY_STORAGE_KEY = "standby-radar:stable-assignments:v1";
const MIN_HOLD_MS = 30 * 60 * 1000;
const CHANGE_CONFIRM_MS = 5 * 60 * 1000;
const CHANGE_MARGIN = 15;
const EMERGENCY_SCORE = 80;
const MAX_RESTORE_AGE_MS = 2 * 60 * 60 * 1000;
const AUTO_REFRESH_MS = 30_000;
const CLUSTER_DISTANCE_METERS = 1_100;
const REGIONAL_WATCHES: RegionalWatch[] = [
  {
    id: "arnhem-nijmegen",
    name: "Arnhem–Nijmegen",
    lat: 51.900,
    lng: 5.840,
    radiusKm: 27,
    roads: ["A12", "A15", "A50", "A73", "A325", "A326"],
  },
];

const esc = (s: string) => s.replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c] ?? c));
const clock = (s?: string | number | null) => { if (s === null || s === undefined) return "—"; const d = new Date(s); return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: typeof s === "number" ? undefined : "2-digit" }); };
const tone = (score: number) => score >= 65 ? "hot" : score >= 38 ? "warm" : "normal";
const allow = (kind: TrafficKind, f: Filters) => kind === "traffic" ? f.traffic : kind === "works" ? f.works : f.incidents;
const speedLabel = (value: number | null) => value === null ? "—" : `${Math.round(value)} km/u`;
const flowLabel = (value: number | null) => value === null ? "—" : `${value.toLocaleString("nl-NL")} vtg/u`;
const locationSource = (a: StandbyAdvice) => a.standby.source === "rws" ? "officiële RWS-locatie" : "OSM-kandidaat";
const segmentLabel = (a: StandbyAdvice) => `${a.road} km ${a.kmFrom}–${a.kmTo}`;
const minutesLabel = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;
const rad = (value: number) => value * Math.PI / 180;

function eventMarkerType(event: TrafficEvent): EventMarkerType {
  const text = `${event.type} ${event.title}`.toLowerCase();
  if (text.includes("brokendown") || text.includes("defect") || text.includes("stilstaand")) return "breakdown";
  if (event.kind === "accident") return "accident";
  if (event.kind === "traffic") return "traffic";
  if (event.kind === "works") return "works";
  if (event.kind === "closure") return "closure";
  if (event.kind === "weather") return "weather";
  return "obstruction";
}

function eventTypeLabel(type: EventMarkerType) {
  return ({ breakdown: "Stilstaand voertuig", accident: "Ongeval", obstruction: "Obstakel", traffic: "File", works: "Werkzaamheden", closure: "Afsluiting", weather: "Weer" } as const)[type];
}

function eventGlyph(type: EventMarkerType | "standby") {
  if (type === "breakdown") return '<path d="M5.5 14.5h13l-1.2-4.1a2 2 0 0 0-1.9-1.4H8.6a2 2 0 0 0-1.9 1.4L5.5 14.5Z"/><path d="M7 14.5v2M17 14.5v2"/><circle cx="8" cy="17" r="1.4"/><circle cx="16" cy="17" r="1.4"/><path d="M9 12h6"/>';
  if (type === "accident") return '<path d="M12 4 20 19H4L12 4Z"/><path d="M12 9v5"/><path d="M12 17h.01"/>';
  if (type === "obstruction") return '<path d="M5 18h14M7 18l2-9h6l2 9M8 13h8M9 9h6"/>';
  if (type === "traffic") return '<path d="M7 5h10v14H7z"/><circle cx="12" cy="9" r="1.6"/><circle cx="12" cy="15" r="1.6"/>';
  if (type === "works") return '<path d="M5 18h14M8 18l2-11h4l2 11M9 12h6"/><path d="M6 8h3M15 8h3"/>';
  if (type === "closure") return '<circle cx="12" cy="12" r="7"/><path d="m7 17 10-10"/>';
  if (type === "weather") return '<path d="M7 15a4 4 0 1 1 1.5-7.7A5 5 0 0 1 18 10a3 3 0 0 1-1 5H7Z"/><path d="M9 18l-1 2M13 18l-1 2M17 18l-1 2"/>';
  return '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>';
}

function sourceBadge(source: string | null) {
  const value = (source ?? "").toLowerCase();
  if (value.includes("tomtom")) return "T";
  if (value.includes("rws")) return "R";
  if (value.includes("ndw")) return "N";
  return "•";
}

function eventIconHtml(event: TrafficEvent) {
  const type = eventMarkerType(event);
  return `<span class="event-pin event-pin--${type}" title="${esc(eventTypeLabel(type))}"><svg viewBox="0 0 24 24" aria-hidden="true">${eventGlyph(type)}</svg><span class="event-pin__source">${sourceBadge(event.source)}</span></span>`;
}

function standbyIconHtml(score: number, isStable: boolean, isSelected: boolean) {
  return `<span class="standby-marker standby-marker--${tone(score)}${isStable ? " standby-marker--stable" : ""}${isSelected ? " standby-marker--selected" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true">${eventGlyph("standby")}</svg><b>${score}</b></span>`;
}

function regionalWatchIconHtml(score: number, activeUnits: number) {
  return `<span class="regional-watch-marker regional-watch-marker--${tone(score)}${activeUnits > 0 ? " regional-watch-marker--active" : ""}"><span>AN</span><b>${score}</b></span>`;
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function clusterEvents(events: TrafficEvent[]): EventCluster[] {
  const used = new Set<number>();
  const groups: EventCluster[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if (used.has(index)) continue;
    const seed = events[index];
    const neighbors = events.map((event, candidate) => ({ event, candidate }))
      .filter(({ event, candidate }) => !used.has(candidate) && event.roadRef === seed.roadRef && distanceMeters(seed, event) <= CLUSTER_DISTANCE_METERS);
    const clusterable = neighbors.length >= 3;
    const members = clusterable ? neighbors : [{ event: seed, candidate: index }];
    members.forEach(({ candidate }) => used.add(candidate));
    groups.push({
      events: members.map(({ event }) => event),
      lat: members.reduce((sum, { event }) => sum + event.lat, 0) / members.length,
      lng: members.reduce((sum, { event }) => sum + event.lng, 0) / members.length,
      roadRef: seed.roadRef,
    });
  }
  return groups;
}

function historyFor(advice: StandbyAdvice, history: HistoryData | null): HistoryMatch {
  if (!history) return { accidents: 0, score: 0, severe: 0, years: [] };
  const matching = history.segments.filter(segment =>
    segment.road === advice.road && segment.kmFrom < advice.kmTo && segment.kmTo > advice.kmFrom,
  );
  return {
    accidents: matching.reduce((sum, segment) => sum + segment.accidents, 0),
    score: matching.reduce((max, segment) => Math.max(max, segment.historyScore), 0),
    severe: matching.reduce((sum, segment) => sum + segment.severe, 0),
    years: [...new Set(matching.flatMap(segment => segment.years))].sort(),
  };
}

function operationalCandidates(advice: StandbyAdvice[]) {
  const byLocation = new Map<string, StandbyAdvice>();
  for (const item of advice) {
    if (item.recommendedUnits <= 0) continue;
    const previous = byLocation.get(item.standby.id);
    if (!previous || item.score > previous.score) byLocation.set(item.standby.id, item);
  }
  return [...byLocation.values()].sort((a, b) => b.score - a.score);
}

function standbySignature(advice: StandbyAdvice[]) {
  return advice.map(item => `${item.standby.id}:${item.recommendedUnits}`).sort().join("|");
}

function setQuality(advice: StandbyAdvice[]) {
  return advice.reduce((sum, item) => sum + item.score * Math.max(1, item.recommendedUnits), 0);
}

export function RadarDashboard() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const trafficLayerRef = useRef<TileLayer | null>(null);
  const requestSeq = useRef(0);
  const inFlightRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);
  const lastGoodAdvice = useRef<StandbyAdvice[]>([]);
  const stabilityRef = useRef<StabilityState>({ loaded: false, advice: [], since: 0, pendingSignature: null, pendingSince: null });

  const [mapReady, setMapReady] = useState(false);
  const [data, setData] = useState<LiveRadarData | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoUpdating, setAutoUpdating] = useState(false);
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [filters, setFilters] = useState<Filters>({ traffic: true, incidents: true, works: false, advice: true });
  const [stableStandby, setStableStandby] = useState<StandbyAdvice[]>([]);
  const [stableSince, setStableSince] = useState<number | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);

  const fetchPayload = useCallback(async () => {
    const r = await fetch(`/api/live?_=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Live feed HTTP ${r.status}`);
    return await r.json() as LiveRadarData;
  }, []);

  const load = useCallback(async (manual = false) => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    const seq = ++requestSeq.current;
    if (manual) setRefreshing(true); else setAutoUpdating(true);
    try {
      let payload = await fetchPayload();
      const shouldHaveAdvice = payload.meta.segmentCount > 0 && payload.meta.candidateLocationCount > 0;
      if (shouldHaveAdvice && payload.advice.length === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 900));
        payload = await fetchPayload();
      }
      if (seq !== requestSeq.current) return false;
      if (payload.advice.length) lastGoodAdvice.current = payload.advice;
      const effectiveAdvice = payload.advice.length ? payload.advice : lastGoodAdvice.current;
      setData(effectiveAdvice === payload.advice ? payload : { ...payload, advice: effectiveAdvice });
      setSelectedId(current => current && effectiveAdvice.some(a => a.id === current) ? current : effectiveAdvice[0]?.id ?? null);
      setError(shouldHaveAdvice && payload.advice.length === 0 ? "De live brondata is binnen, maar de stand-byselectie leverde tijdelijk geen locaties op. De laatste geldige adviezen blijven zichtbaar." : null);
      return true;
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : "Live data kon niet geladen worden");
      return false;
    } finally {
      if (seq === requestSeq.current) { setLoading(false); setRefreshing(false); setAutoUpdating(false); }
      inFlightRef.current = false;
    }
  }, [fetchPayload]);

  useEffect(() => {
    let cancelled = false;
    const scheduleNext = () => {
      if (cancelled) return;
      const due = Date.now() + AUTO_REFRESH_MS;
      setNextRefreshAt(due);
      refreshTimerRef.current = window.setTimeout(async () => {
        if (cancelled) return;
        setNextRefreshAt(null);
        await load(false);
        if (!cancelled) scheduleNext();
      }, AUTO_REFRESH_MS);
    };
    void (async () => { setNextRefreshAt(null); await load(false); if (!cancelled) scheduleNext(); })();
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { cancelled = true; if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current); clearInterval(tick); };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const loadHistory = async () => {
      try {
        const r = await fetch("/api/history", { cache: "force-cache" });
        if (!r.ok) return;
        const payload = await r.json() as HistoryData;
        if (!cancelled) setHistory(payload);
      } catch {}
    };
    void loadHistory();
    const refresh = window.setInterval(() => void loadHistory(), 60 * 60 * 1000);
    return () => { cancelled = true; clearInterval(refresh); };
  }, []);

  useEffect(() => {
    if (!data) return;
    const currentTime = Date.now();
    const raw = operationalCandidates(data.advice);
    const state = stabilityRef.current;
    if (!state.loaded) {
      state.loaded = true;
      try {
        const saved = localStorage.getItem(STANDBY_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as Partial<StabilityState>;
          if (Array.isArray(parsed.advice) && typeof parsed.since === "number" && currentTime - parsed.since <= MAX_RESTORE_AGE_MS) {
            state.advice = parsed.advice;
            state.since = parsed.since;
            state.pendingSignature = typeof parsed.pendingSignature === "string" ? parsed.pendingSignature : null;
            state.pendingSince = typeof parsed.pendingSince === "number" ? parsed.pendingSince : null;
          }
        }
      } catch {}
    }
    const persist = () => { try { localStorage.setItem(STANDBY_STORAGE_KEY, JSON.stringify({ advice: state.advice, since: state.since, pendingSignature: state.pendingSignature, pendingSince: state.pendingSince })); } catch {} };
    const publish = () => { setStableStandby([...state.advice]); setStableSince(state.since || null); setPendingSince(state.pendingSince); persist(); };
    const commit = (nextAdvice: StandbyAdvice[], reasonTime = currentTime) => { state.advice = nextAdvice; state.since = reasonTime; state.pendingSignature = null; state.pendingSince = null; publish(); };
    if (!state.advice.length) { if (raw.length) commit(raw); else publish(); return; }
    const freshByLocation = new Map(data.advice.map(item => [item.standby.id, item]));
    state.advice = state.advice.map(assigned => { const live = freshByLocation.get(assigned.standby.id); return live ? { ...live, recommendedUnits: assigned.recommendedUnits } : assigned; });
    const stableSignature = standbySignature(state.advice);
    const rawSignature = standbySignature(raw);
    if (rawSignature === stableSignature) { state.advice = raw; state.pendingSignature = null; state.pendingSince = null; publish(); return; }
    const emergency = raw.some(item => item.score >= EMERGENCY_SCORE && item.corroboratingSignals >= 2 && (item.accidents > 0 || item.obstructions > 0 || item.matrixClusters >= 3));
    if (emergency) { commit(raw); return; }
    const holdAge = currentTime - state.since;
    if (holdAge < MIN_HOLD_MS) { state.pendingSignature = rawSignature || "none"; state.pendingSince = null; publish(); return; }
    const currentStillUseful = state.advice.some(item => item.score >= 38);
    const improvement = setQuality(raw) - setQuality(state.advice);
    const materiallyBetter = !currentStillUseful || improvement >= CHANGE_MARGIN;
    if (!materiallyBetter) { state.pendingSignature = null; state.pendingSince = null; publish(); return; }
    const targetSignature = rawSignature || "none";
    if (state.pendingSignature !== targetSignature || !state.pendingSince) { state.pendingSignature = targetSignature; state.pendingSince = currentTime; publish(); return; }
    if (currentTime - state.pendingSince >= CHANGE_CONFIRM_MS) { commit(raw); return; }
    publish();
  }, [data]);

  useEffect(() => {
    let dead = false;
    void (async () => {
      if (!mapEl.current || mapRef.current) return;
      const L = await import("leaflet");
      if (dead || !mapEl.current) return;
      leafletRef.current = L;
      const map = L.map(mapEl.current, { center: [51.75, 5.45], zoom: 8, zoomControl: false, preferCanvas: true });

      // OSM blijft onderop als stille fallback wanneer een TomTom tile tijdelijk niet beschikbaar is.
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        zIndex: 1,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      L.tileLayer("/api/tomtom-map/{z}/{x}/{y}", {
        maxZoom: 22,
        maxNativeZoom: 22,
        zIndex: 2,
        attribution: "Map &copy; TomTom",
      }).addTo(map);

      const trafficLayer = L.tileLayer("/api/tomtom-traffic/{z}/{x}/{y}", {
        maxZoom: 22,
        maxNativeZoom: 22,
        zIndex: 180,
        opacity: 0.78,
        updateWhenIdle: false,
        keepBuffer: 3,
        attribution: "Traffic &copy; TomTom",
      });
      trafficLayer.addTo(map);
      trafficLayerRef.current = trafficLayer;

      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      map.fitBounds([[51.2, 4.2], [52.3, 6.55]], { padding: [20, 20], maxZoom: 9 });
      mapRef.current = map;
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 60);
    })();
    return () => {
      dead = true;
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
      layerRef.current = null;
      trafficLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const trafficLayer = trafficLayerRef.current;
    if (!mapReady || !map || !trafficLayer) return;
    if (filters.traffic) {
      if (!map.hasLayer(trafficLayer)) trafficLayer.addTo(map);
    } else if (map.hasLayer(trafficLayer)) {
      map.removeLayer(trafficLayer);
    }
  }, [mapReady, filters.traffic]);

  useEffect(() => {
    const L = leafletRef.current, layer = layerRef.current;
    if (!mapReady || !L || !layer || !data) return;
    layer.clearLayers();

    if (filters.advice) {
      const stableIds = new Set(stableStandby.map(item => item.standby.id));
      const bestByLocation = new Map<string, StandbyAdvice>();
      for (const advice of data.advice) {
        const previous = bestByLocation.get(advice.standby.id);
        if (!previous || advice.score > previous.score) bestByLocation.set(advice.standby.id, advice);
      }
      for (const advice of bestByLocation.values()) {
        const hist = historyFor(advice, history);
        const isStable = stableIds.has(advice.standby.id);
        const icon = L.divIcon({ className: "standby-div-icon", html: standbyIconHtml(advice.score, isStable, selectedId === advice.id), iconSize: [48, 48], iconAnchor: [24, 24], popupAnchor: [0, -20] });
        const marker = L.marker([advice.standby.lat, advice.standby.lng], { icon, zIndexOffset: isStable ? 360 : 260 });
        marker.bindPopup(`<div class="radar-popup radar-popup--standby"><div class="popup-kicker">${isStable ? "GESTABILISEERDE POSITIE" : "LIVE KANDIDAAT"}</div><strong>${esc(advice.standby.name)}</strong><span>${esc(advice.standby.address)}</span><span>${esc(locationSource(advice))}</span><hr><b>${esc(segmentLabel(advice))}</b><span>${speedLabel(advice.averageSpeedKph)} · ${flowLabel(advice.flowVehiclesPerHour)}</span><span>Actuele score ${advice.score}/100 · zekerheid ${esc(advice.confidence)}</span>${hist.accidents ? `<span>Historie: ${hist.accidents} BRON-ongeval(len) · ${hist.score}/15</span>` : ""}</div>`);
        marker.on("click", () => setSelectedId(advice.id));
        marker.addTo(layer);
      }

      for (const watch of REGIONAL_WATCHES) {
        const center = { lat: watch.lat, lng: watch.lng };
        const nearbyEvents = data.events.filter(event => watch.roads.includes(event.roadRef ?? "") && distanceMeters(center, event) <= watch.radiusKm * 1000);
        const nearbyAdvice = data.advice
          .filter(advice => watch.roads.includes(advice.road) && distanceMeters(center, advice.standby) <= watch.radiusKm * 1000)
          .sort((a, b) => (b.trafficPressureScore ?? b.score) - (a.trafficPressureScore ?? a.score));
        const nearbyStable = stableStandby.filter(advice => watch.roads.includes(advice.road) && distanceMeters(center, advice.standby) <= watch.radiusKm * 1000);
        const activeUnits = nearbyStable.reduce((sum, advice) => sum + advice.recommendedUnits, 0);
        const best = nearbyAdvice[0] ?? null;
        const livePressure = best?.trafficPressureScore ?? best?.score ?? 0;
        const eventPressure = Math.min(78, nearbyEvents.reduce((sum, event) => {
          const type = eventMarkerType(event);
          const weight = type === "accident" ? 18 : type === "breakdown" ? 16 : type === "closure" ? 15 : type === "obstruction" ? 12 : type === "traffic" ? 8 : type === "weather" ? 6 : 4;
          return sum + weight;
        }, 0));
        const score = Math.round(Math.max(livePressure, eventPressure));
        const state = activeUnits > 0 ? `STANDBY ACTIEF · ${activeUnits}×` : score >= 65 ? "STANDBY OVERWEGEN" : score >= 38 ? "EXTRA MONITOREN" : "REGIO MONITOREN";
        const accidents = nearbyEvents.filter(event => eventMarkerType(event) === "accident").length;
        const breakdowns = nearbyEvents.filter(event => eventMarkerType(event) === "breakdown").length;
        const icon = L.divIcon({ className: "regional-watch-div-icon", html: regionalWatchIconHtml(score, activeUnits), iconSize: [42, 42], iconAnchor: [21, 21], popupAnchor: [0, -18] });
        const marker = L.marker([watch.lat, watch.lng], { icon, zIndexOffset: 230 });
        marker.bindPopup(`<div class="radar-popup radar-popup--regional"><div class="popup-kicker">REGIOWATCH</div><strong>${esc(watch.name)}</strong><span>${watch.roads.join(" · ")}</span><hr><b>${esc(state)}</b><span>Regiosignaal ${score}/100 · ${nearbyEvents.length} actuele melding(en) binnen ${watch.radiusKm} km</span><span>${accidents} ongeval(len) · ${breakdowns} stilstaand/defect</span>${best ? `<span>Hoogste gekoppelde wegvakdruk: ${esc(segmentLabel(best))} · ${best.trafficPressureScore ?? best.score}/100</span><span>Dichtst bruikbare kandidaat: ${esc(best.standby.name)}</span>` : `<span>Nog geen bruikbare stand-bykandidaat in deze zone gekoppeld; de regio blijft wel permanent zichtbaar voor drukte en incidenten.</span>`}<small>TomTom live verkeersflow blijft de lokale verkeerslaag op de kaart.</small></div>`, { maxWidth: 350 });
        marker.on("click", () => mapRef.current?.setView([watch.lat, watch.lng], Math.max(mapRef.current.getZoom(), 10), { animate: true }));
        L.circle([watch.lat, watch.lng], {
          radius: watch.radiusKm * 1000,
          color: score >= 65 ? "#e25b4a" : score >= 38 ? "#e5ad4f" : "#66bfd4",
          weight: 1,
          opacity: .34,
          fillOpacity: .018,
          dashArray: "5 7",
          interactive: false,
        }).addTo(layer);
        marker.addTo(layer);
      }
    }

    const visibleEvents = data.events.filter(event => allow(event.kind, filters));
    for (const group of clusterEvents(visibleEvents)) {
      if (group.events.length >= 3) {
        const types = group.events.map(eventMarkerType);
        const critical = types.includes("accident") || types.includes("breakdown");
        const icon = L.divIcon({ className: "event-div-icon", html: `<span class="event-cluster${critical ? " event-cluster--critical" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true">${eventGlyph(critical ? "accident" : "obstruction")}</svg><b>${group.events.length}</b></span>`, iconSize: [42, 42], iconAnchor: [21, 21], popupAnchor: [0, -18] });
        const marker = L.marker([group.lat, group.lng], { icon, zIndexOffset: 430 });
        const rows = group.events.slice(0, 8).map(event => `<li><b>${esc(eventTypeLabel(eventMarkerType(event)))}</b> · ${esc(event.title)}<small>${esc(event.source ?? "bron onbekend")} · ${esc(clock(event.updatedAt))}</small></li>`).join("");
        marker.bindPopup(`<div class="radar-popup radar-popup--cluster"><div class="popup-kicker">${group.events.length} MELDINGEN BIJ ELKAAR</div><strong>${esc(group.roadRef ?? "IM-weg")}</strong><ul>${rows}</ul></div>`, { maxWidth: 340 });
        marker.on("click", () => marker.getElement()?.querySelector(".event-cluster")?.classList.add("event-cluster--selected"));
        marker.addTo(layer);
        continue;
      }

      const event = group.events[0];
      const type = eventMarkerType(event);
      const icon = L.divIcon({ className: "event-div-icon", html: eventIconHtml(event), iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -15] });
      const marker = L.marker([event.lat, event.lng], { icon, zIndexOffset: type === "accident" || type === "breakdown" ? 440 : 400 });
      const roadBits = [event.roadRef, event.roadKm != null ? `km ${event.roadKm}` : null, event.direction].filter(Boolean).join(" · ");
      marker.bindPopup(`<div class="radar-popup radar-popup--event"><div class="popup-event-head"><span class="popup-event-symbol popup-event-symbol--${type}"><svg viewBox="0 0 24 24">${eventGlyph(type)}</svg></span><div><div class="popup-kicker">${esc(eventTypeLabel(type))}</div><strong>${esc(event.title)}</strong></div></div><span>${esc(roadBits || "IM-weg")}</span><div class="popup-source"><b>${sourceBadge(event.source)}</b><span>Bron ${esc(event.source ?? "onbekend")}<small>Bijgewerkt ${esc(clock(event.updatedAt))}</small></span></div></div>`);
      marker.on("click", () => {
        document.querySelectorAll(".event-pin--selected").forEach(node => node.classList.remove("event-pin--selected"));
        marker.getElement()?.querySelector(".event-pin")?.classList.add("event-pin--selected");
      });
      marker.addTo(layer);
    }
  }, [mapReady, data, history, filters, stableStandby, selectedId]);

  const selected = useMemo(() => data?.advice.find(a => a.id === selectedId) ?? data?.advice[0] ?? null, [data, selectedId]);
  const selectedHistory = useMemo(() => selected ? historyFor(selected, history) : null, [selected, history]);
  const motorwayStatus = useMemo(() => {
    if (!data) return [];
    return data.meta.roads.map(road => {
      const rows = data.advice.filter(item => item.road === road);
      const best = rows.slice().sort((a, b) => b.score - a.score)[0] ?? null;
      const incidents = data.events.filter(event => event.roadRef === road).length;
      const matrix = data.matrix.byRoad.find(item => item.road === road)?.active ?? 0;
      const measured = rows.filter(item => item.sensorCount > 0).length;
      return { road, best, score: best?.score ?? 0, incidents, matrix, measured, hasLocation: rows.length > 0 };
    });
  }, [data]);
  const activeStandby = stableStandby;
  const activeUnitCount = activeStandby.reduce((sum, advice) => sum + advice.recommendedUnits, 0);
  const next = nextRefreshAt ? Math.max(0, Math.ceil((nextRefreshAt - now) / 1000)) : 0;
  const holdRemaining = stableSince ? Math.max(0, MIN_HOLD_MS - (now - stableSince)) : 0;
  const pendingRemaining = pendingSince ? Math.max(0, CHANGE_CONFIRM_MS - (now - pendingSince)) : 0;
  const focus = (advice: StandbyAdvice) => { setSelectedId(advice.id); mapRef.current?.setView([advice.standby.lat, advice.standby.lng], 13, { animate: true }); };

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><span /></span><div><strong>STANDBY RADAR</strong><small>Realtime verkeersdruk + historische risicocontext</small></div></div>
      <div className="topbar-right"><span className="scope">VAN EIJCK WERKGEBIED</span><span className="update">{data ? `live ${clock(data.generatedAt)} · ${nextRefreshAt ? `${next}s` : autoUpdating ? "bijwerken…" : "wachten…"}` : "verbinden…"}</span><button disabled={refreshing || autoUpdating} onClick={() => void load(true)}>{refreshing ? "VERVERSEN…" : autoUpdating ? "BIJWERKEN…" : "NU VERVERSEN"}</button></div>
    </header>

    <section className="workspace">
      <div className="map-panel">
        <div ref={mapEl} className="map" aria-label="Standby Radar kaart" />
        {loading && <div className="loading-card">LIVE BRONNEN LADEN…</div>}
        <div className="map-hud"><div className="stats">
          <Stat label="Wegsegmenten" value={data?.meta.segmentCount} /><Stat label="Snelwegen" value={data?.meta.roadCount} /><Stat label="Verse meetpunten" value={data?.meta.measuredSiteCount} /><Stat label="Kandidaatplekken" value={data?.meta.candidateLocationCount} />
        </div><div className="filters">
          <Filter label="Verkeersflow" active={filters.traffic} onClick={() => setFilters(f => ({ ...f, traffic: !f.traffic }))} />
          <Filter label="Incidenten" active={filters.incidents} onClick={() => setFilters(f => ({ ...f, incidents: !f.incidents }))} />
          <Filter label="Werkzaamheden" active={filters.works} onClick={() => setFilters(f => ({ ...f, works: !f.works }))} />
          <Filter label="Stand-by" active={filters.advice} onClick={() => setFilters(f => ({ ...f, advice: !f.advice }))} />
        </div></div>

        <section className="standby-now-panel" aria-label="Actuele stand-byadviezen">
          <div className="standby-now-heading">
            <div><small>GESTABILISEERD OPERATIONEEL ADVIES</small><strong>NU STANDBY</strong></div>
            <span className={activeUnitCount > 0 ? "standby-now-count standby-now-count--active" : "standby-now-count"}>{activeUnitCount} voertuig{activeUnitCount === 1 ? "" : "en"}</span>
          </div>
          <div className="standby-now-list">
            {activeStandby.map((advice, index) => <button key={advice.standby.id} className="standby-now-item" onClick={() => focus(advice)}>
              <b>{advice.recommendedUnits}×</b>
              <span><strong>{index + 1}. {advice.standby.name}</strong><small>{advice.standby.address}</small><em>{segmentLabel(advice)} · actuele score {advice.score}/100 · {advice.confidence}</em></span>
            </button>)}
            {!loading && activeStandby.length === 0 && <div className="standby-now-empty"><strong>Geen actieve stand-by nodig</strong><span>Geen wegdeel staat nu boven de operationele drempel.</span></div>}
          </div>
          <footer>{activeStandby.length > 0 && stableSince ? <>Vast sinds {clock(stableSince)} · {holdRemaining > 0 ? `minimaal nog ${minutesLabel(holdRemaining)} op positie` : pendingSince ? `alternatief wordt bevestigd · nog ${minutesLabel(pendingRemaining)}` : `alleen wisselen bij ≥${CHANGE_MARGIN} punten voordeel gedurende 5 min`}</> : "Live analyse iedere 30 sec."}</footer>
        </section>

        <div className="legend">
          <span><LegendIcon type="breakdown" /> Stilstaand</span><span><LegendIcon type="accident" /> Ongeval</span><span><LegendIcon type="obstruction" /> Obstakel</span><span><LegendIcon type="traffic" /> File/traag</span><span><LegendIcon type="works" /> Werk</span><span><LegendIcon type="standby" /> Kandidaat</span><span><LegendIcon type="stable" /> Gestabiliseerd</span><span><i className="legend-icon legend-icon--regional">AN</i> Regiowatch</span>
        </div>
      </div>

      <aside className="sidebar">
        <div className="sidebar-layout">
          <div className="side-scroll">
            {error && <div className="error-card">{error}</div>}
            <section className="block"><div className="block-title"><strong>BRONSTATUS</strong><span>{data?.sources.filter(s => s.ok).length ?? 0}/{data?.sources.length ?? 9} online</span></div><div className="sources">{data?.sources.map(source => <span key={source.id} className={source.ok ? "source source--ok" : "source"} title={`${source.lineage ?? ""}${source.updatedAt ? ` · ${clock(source.updatedAt)}` : ""}${source.error ? ` · ${source.error}` : ""}`}>{source.name}</span>)}{history && <span className={history.error ? "source" : "source source--ok"} title={history.note}>{history.error ? "BRON historie fout" : "RWS BRON historie"}</span>}</div></section>

            <section className="block motorway-status-block"><div className="block-title"><strong>ALLE SNELWEGEN</strong><span>{data?.meta.roadCount ?? 0} gevolgd</span></div><div className="motorway-grid">
              {motorwayStatus.map(status => <button key={status.road} className={`motorway-chip motorway-chip--${tone(status.score)} ${status.best ? "" : "motorway-chip--unlocated"}`} onClick={() => status.best && focus(status.best)} title={status.best ? `${status.road}: hoogste actuele score ${status.score}/100` : `${status.road}: wordt gevolgd; momenteel geen stand-byplek aan een segment gekoppeld`}>
                <strong>{status.road}</strong><b>{status.best ? status.score : "•"}</b><small>{status.incidents ? `${status.incidents} inc` : status.matrix ? `${status.matrix} matrix` : status.measured ? "live" : "gevolgd"}</small>
              </button>)}
            </div><p className="motorway-note">Iedere A-weg uit het actuele IM-contract blijft in de analyse, ook zonder lokale meetlus of stand-byplek. Een marker verschijnt pas waar ook een bruikbare locatie aan het wegdeel kan worden gekoppeld.</p></section>

            <section className="block"><div className="block-title"><strong>LIVE WEGVAKANALYSE</strong><span>{data?.advice.length ?? 0} met locatie</span></div><div className="advice-list">
              {data?.advice.slice(0, 12).map((advice, index) => { const hist = historyFor(advice, history); return <button key={advice.id} className={`advice-card ${selected?.id === advice.id ? "advice-card--selected" : ""}`} onClick={() => focus(advice)}>
                <span className={`score score--${tone(advice.score)}`}>{advice.score}</span><span className="advice-copy"><strong>{index + 1}. {segmentLabel(advice)}<em>{advice.recommendedUnits}×</em></strong><small>Live kandidaat → {advice.standby.name} · {locationSource(advice)}</small><span>{speedLabel(advice.averageSpeedKph)} · {flowLabel(advice.flowVehiclesPerHour)} · {advice.sensorCount} meetpunt(en)</span>{hist.accidents > 0 && <small>Historie 2022–2024: {hist.accidents} ongeval(len) · risico {hist.score}/15</small>}<small>{advice.standby.address}</small></span>
              </button>; })}
              {!loading && data && data.advice.length === 0 && <div className="error-card">Geen live wegvakanalyse ontvangen terwijl er wel brondata beschikbaar is. Automatische herpoging loopt bij de volgende refresh.</div>}
            </div></section>

            <div className="disclaimer"><strong>MODEL {data?.meta.modelVersion ?? "—"}</strong><p>Alle gecontracteerde A-wegvakken worden gemonitord. Stand-byposities worden bewust gestabiliseerd om onnodige verplaatsingen en lege kilometers te voorkomen.</p>{history && <p>Historische context: {history.source}. {history.note}</p>}</div>
          </div>

          {selected && <section className="why-card why-card--fixed"><div className="why-heading"><div><small>WAAROM DEZE PLEK?</small><strong>{segmentLabel(selected)}</strong><span className="standby-address">→ {selected.standby.name}<br />{selected.standby.address}</span></div><b>{selected.score}</b></div>
            <div className="why-grid"><Metric label="Snelheid" value={speedLabel(selected.averageSpeedKph)} /><Metric label="Intensiteit" value={flowLabel(selected.flowVehiclesPerHour)} /><Metric label="Meetpunten" value={selected.sensorCount} /><Metric label="Bronbevestiging" value={`${selected.corroboratingSignals}/4`} /><Metric label="Matrix lokaal" value={selected.matrixClusters} /><Metric label="Historisch risico" value={`${selectedHistory?.score ?? 0}/15`} /></div>
            <ul>{selected.reasons.filter(reason => !reason.includes("IM-rayon")).map(reason => <li key={reason}>{reason}</li>)}{selectedHistory && selectedHistory.accidents > 0 && <li>Historie: {selectedHistory.accidents} geregistreerde BRON-ongevallen in overlappende 5-km-vakken ({selectedHistory.years.join(", ")}){selectedHistory.severe ? `, waarvan ${selectedHistory.severe} met zwaardere afloop` : ""}.</li>}</ul>
            <p>De live wegvakanalyse ververst iedere 30 seconden. De operationele stand-bypositie links onder gebruikt daarnaast een stabiliteitsregel: minimaal 30 minuten blijven, daarna alleen wisselen als een alternatief minimaal 15 punten beter is en dit 5 minuten aanhoudt. Alleen bij een uitzonderlijk zwaar live signaal kan direct worden gewisseld.</p>
          </section>}
        </div>
      </aside>
    </section>
  </main>;
}

function Stat({ label, value }: { label: string; value?: number }) { return <div className="stat"><small>{label}</small><strong>{value ?? "—"}</strong></div>; }
function Filter({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) { return <button className={active ? "filter filter--active" : "filter"} onClick={onClick}>{label}</button>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
function LegendIcon({ type }: { type: EventMarkerType | "standby" | "stable" }) {
  const visual = type === "stable" ? "standby" : type;
  return <i className={`legend-icon legend-icon--${type}`}><svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: eventGlyph(visual as EventMarkerType | "standby") }} /></i>;
}