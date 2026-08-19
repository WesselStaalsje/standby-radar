"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import type { LiveRadarData, StandbyAdvice, TrafficKind } from "@/lib/types";

type Filters = { traffic: boolean; incidents: boolean; works: boolean; advice: boolean };
type HistoricalSegment = { id: string; road: string; kmFrom: number; kmTo: number; accidents: number; weightedRisk: number; historyScore: number; years: number[]; severe: number };
type HistoryData = { generatedAt: string; source: string; totalRecords: number; mappedRecords?: number; segments: HistoricalSegment[]; note?: string; error?: string };
type HistoryMatch = { accidents: number; score: number; severe: number; years: number[] };

const colors: Record<TrafficKind, string> = {
  traffic: "#f1a34b", accident: "#e44c4c", obstruction: "#df7a43",
  closure: "#a84f6c", works: "#7a7d8b", weather: "#4a8db8",
};

const esc = (s: string) => s.replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c] ?? c));
const clock = (s?: string | null) => { if (!s) return "—"; const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
const tone = (score: number) => score >= 65 ? "hot" : score >= 38 ? "warm" : "normal";
const allow = (kind: TrafficKind, f: Filters) => kind === "traffic" ? f.traffic : kind === "works" ? f.works : f.incidents;
const speedLabel = (value: number | null) => value === null ? "—" : `${Math.round(value)} km/u`;
const flowLabel = (value: number | null) => value === null ? "—" : `${value.toLocaleString("nl-NL")} vtg/u`;
const locationSource = (a: StandbyAdvice) => a.standby.source === "rws" ? "officiële RWS-locatie" : "OSM-kandidaat";
const segmentLabel = (a: StandbyAdvice) => `${a.road} km ${a.kmFrom}–${a.kmTo}`;

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

export function RadarDashboard() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const requestSeq = useRef(0);
  const lastGoodAdvice = useRef<StandbyAdvice[]>([]);

  const [mapReady, setMapReady] = useState(false);
  const [data, setData] = useState<LiveRadarData | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [filters, setFilters] = useState<Filters>({ traffic: true, incidents: true, works: false, advice: true });

  const fetchPayload = useCallback(async () => {
    const r = await fetch(`/api/live?_=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Live feed HTTP ${r.status}`);
    return await r.json() as LiveRadarData;
  }, []);

  const load = useCallback(async (manual = false) => {
    const seq = ++requestSeq.current;
    if (manual) setRefreshing(true);
    try {
      let payload = await fetchPayload();
      const shouldHaveAdvice = payload.meta.segmentCount > 0 && payload.meta.candidateLocationCount > 0;
      if (shouldHaveAdvice && payload.advice.length === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 900));
        if (seq !== requestSeq.current) return;
        payload = await fetchPayload();
      }
      if (seq !== requestSeq.current) return;

      if (payload.advice.length) lastGoodAdvice.current = payload.advice;
      const effectiveAdvice = payload.advice.length ? payload.advice : lastGoodAdvice.current;
      setData(effectiveAdvice === payload.advice ? payload : { ...payload, advice: effectiveAdvice });
      setSelectedId(current => current && effectiveAdvice.some(a => a.id === current) ? current : effectiveAdvice[0]?.id ?? null);
      setError(shouldHaveAdvice && payload.advice.length === 0 ? "De live brondata is binnen, maar de stand-byselectie leverde tijdelijk geen locaties op. De laatste geldige adviezen blijven zichtbaar." : null);
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : "Live data kon niet geladen worden");
    } finally {
      if (seq === requestSeq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [fetchPayload]);

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), 30_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearInterval(refresh); clearInterval(tick); };
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
    let dead = false;
    void (async () => {
      if (!mapEl.current || mapRef.current) return;
      const L = await import("leaflet");
      if (dead || !mapEl.current) return;
      leafletRef.current = L;
      const map = L.map(mapEl.current, { center: [51.75, 5.45], zoom: 8, zoomControl: false, preferCanvas: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      map.fitBounds([[51.2, 4.2], [52.3, 6.55]], { padding: [20, 20], maxZoom: 9 });
      mapRef.current = map;
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 60);
    })();
    return () => { dead = true; mapRef.current?.remove(); mapRef.current = null; leafletRef.current = null; layerRef.current = null; };
  }, []);

  useEffect(() => {
    const L = leafletRef.current, layer = layerRef.current;
    if (!mapReady || !L || !layer || !data) return;
    layer.clearLayers();

    if (filters.advice) {
      const best = new Map<string, StandbyAdvice>();
      for (const advice of data.advice) {
        if (!best.get(advice.standby.id) || (best.get(advice.standby.id)?.score ?? -1) < advice.score) best.set(advice.standby.id, advice);
      }
      for (const advice of best.values()) {
        const hist = historyFor(advice, history);
        const icon = L.divIcon({ className: "standby-div-icon", html: `<span class="standby-pin standby-pin--${tone(advice.score)}">${advice.score}</span>`, iconSize: [38, 38], iconAnchor: [19, 19] });
        const marker = L.marker([advice.standby.lat, advice.standby.lng], { icon, zIndexOffset: 300 });
        marker.bindPopup(`<div class="radar-popup"><strong>${esc(advice.standby.name)}</strong><br>${esc(advice.standby.address)}<br>${esc(locationSource(advice))}<hr><strong>${esc(segmentLabel(advice))}</strong><br>${speedLabel(advice.averageSpeedKph)} · ${flowLabel(advice.flowVehiclesPerHour)}<br>Live score ${advice.score}/100 · zekerheid ${esc(advice.confidence)}${hist.accidents ? `<br>Historie: ${hist.accidents} BRON-ongeval(len) · ${hist.score}/15` : ""}</div>`);
        marker.on("click", () => setSelectedId(advice.id));
        marker.addTo(layer);
      }
    }

    for (const event of data.events) {
      if (!allow(event.kind, filters)) continue;
      const marker = L.circleMarker([event.lat, event.lng], { radius: event.kind === "accident" ? 8 : 6, weight: 2, color: "#fff", fillColor: colors[event.kind], fillOpacity: .92 });
      marker.bindPopup(`<div class="radar-popup"><strong>${esc(event.title)}</strong><br>${esc(event.roadRef ?? "IM-weg")}<br>Bron ${esc(event.source ?? "NDW")} · ${esc(clock(event.updatedAt))}</div>`);
      marker.addTo(layer);
    }
  }, [mapReady, data, history, filters]);

  const selected = useMemo(() => data?.advice.find(a => a.id === selectedId) ?? data?.advice[0] ?? null, [data, selectedId]);
  const selectedHistory = useMemo(() => selected ? historyFor(selected, history) : null, [selected, history]);
  const age = data ? Math.max(0, Math.floor((now - new Date(data.generatedAt).getTime()) / 1000)) : 0;
  const next = Math.max(0, (data?.refreshAfterSeconds ?? 30) - age);
  const focus = (advice: StandbyAdvice) => { setSelectedId(advice.id); mapRef.current?.setView([advice.standby.lat, advice.standby.lng], 13, { animate: true }); };

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><span /></span><div><strong>STANDBY RADAR</strong><small>Realtime verkeersdruk + historische risicocontext</small></div></div>
      <div className="topbar-right"><span className="scope">VAN EIJCK WERKGEBIED</span><span className="update">{data ? `live ${clock(data.generatedAt)} · ${next}s` : "verbinden…"}</span><button disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "VERVERSEN…" : "NU VERVERSEN"}</button></div>
    </header>

    <section className="workspace">
      <div className="map-panel">
        <div ref={mapEl} className="map" aria-label="Standby Radar kaart" />
        {loading && <div className="loading-card">LIVE BRONNEN LADEN…</div>}
        <div className="map-hud"><div className="stats">
          <Stat label="Wegsegmenten" value={data?.meta.segmentCount} /><Stat label="Verse meetpunten" value={data?.meta.measuredSiteCount} /><Stat label="Kandidaatplekken" value={data?.meta.candidateLocationCount} /><Stat label="Matrixacties" value={data?.matrix.activeSignals} />
        </div><div className="filters">
          <Filter label="Verkeer" active={filters.traffic} onClick={() => setFilters(f => ({ ...f, traffic: !f.traffic }))} />
          <Filter label="Incidenten" active={filters.incidents} onClick={() => setFilters(f => ({ ...f, incidents: !f.incidents }))} />
          <Filter label="Werkzaamheden" active={filters.works} onClick={() => setFilters(f => ({ ...f, works: !f.works }))} />
          <Filter label="Stand-by" active={filters.advice} onClick={() => setFilters(f => ({ ...f, advice: !f.advice }))} />
        </div></div>
        <div className="legend"><span><i className="dot accident" /> Ongeval</span><span><i className="dot obstruction" /> Obstakel</span><span><i className="dot traffic" /> File</span><span><i className="ring" /> Automatisch gekozen stand-byplek</span></div>
      </div>

      <aside className="sidebar"><div className="side-scroll">
        {error && <div className="error-card">{error}</div>}

        <section className="block"><div className="block-title"><strong>BRONSTATUS</strong><span>{data?.sources.filter(s => s.ok).length ?? 0}/{data?.sources.length ?? 9} online</span></div><div className="sources">{data?.sources.map(source => <span key={source.id} className={source.ok ? "source source--ok" : "source"} title={`${source.lineage ?? ""}${source.updatedAt ? ` · ${clock(source.updatedAt)}` : ""}${source.error ? ` · ${source.error}` : ""}`}>{source.name}</span>)}{history && <span className={history.error ? "source" : "source source--ok"} title={history.note}>{history.error ? "BRON historie fout" : "RWS BRON historie"}</span>}</div></section>

        <section className="block"><div className="block-title"><strong>LIVE STAND-BYADVIES</strong><span>{data?.advice.length ?? 0} berekend</span></div><div className="advice-list">
          {data?.advice.slice(0, 12).map((advice, index) => { const hist = historyFor(advice, history); return <button key={advice.id} className={`advice-card ${selected?.id === advice.id ? "advice-card--selected" : ""}`} onClick={() => focus(advice)}>
            <span className={`score score--${tone(advice.score)}`}>{advice.score}</span><span className="advice-copy"><strong>{index + 1}. {segmentLabel(advice)}<em>{advice.recommendedUnits}×</em></strong><small>→ {advice.standby.name} · {locationSource(advice)}</small><span>{speedLabel(advice.averageSpeedKph)} · {flowLabel(advice.flowVehiclesPerHour)} · {advice.sensorCount} meetpunt(en)</span>{hist.accidents > 0 && <small>Historie 2022–2024: {hist.accidents} ongeval(len) · risico {hist.score}/15</small>}<small>{advice.standby.address}</small></span>
          </button>; })}
          {!loading && data && data.advice.length === 0 && <div className="error-card">Geen stand-byadviezen ontvangen terwijl er wel brondata beschikbaar is. Automatische herpoging loopt bij de volgende refresh.</div>}
        </div></section>

        {selected && <section className="why-card"><div className="why-heading"><div><small>WAAROM DEZE PLEK?</small><strong>{segmentLabel(selected)}</strong><span className="standby-address">→ {selected.standby.name}<br />{selected.standby.address}</span></div><b>{selected.score}</b></div>
          <div className="why-grid"><Metric label="Snelheid" value={speedLabel(selected.averageSpeedKph)} /><Metric label="Intensiteit" value={flowLabel(selected.flowVehiclesPerHour)} /><Metric label="Meetpunten" value={selected.sensorCount} /><Metric label="Bronbevestiging" value={`${selected.corroboratingSignals}/4`} /><Metric label="Matrix lokaal" value={selected.matrixClusters} /><Metric label="Historisch risico" value={`${selectedHistory?.score ?? 0}/15`} /></div>
          <ul>{selected.reasons.filter(reason => !reason.includes("IM-rayon")).map(reason => <li key={reason}>{reason}</li>)}{selectedHistory && selectedHistory.accidents > 0 && <li>Historie: {selectedHistory.accidents} geregistreerde BRON-ongevallen in overlappende 5-km-vakken ({selectedHistory.years.join(", ")}){selectedHistory.severe ? `, waarvan ${selectedHistory.severe} met zwaardere afloop` : ""}.</li>}</ul>
          <p>De historische factor wordt nu als context getoond en nog niet blind bij de live score opgeteld. Voor echte pech-/stilvalhistorie is eigen bergingsdata of een historische IM-incidentdataset nauwkeuriger dan alleen ongevallen.</p>
        </section>}

        <div className="disclaimer"><strong>MODEL {data?.meta.modelVersion ?? "—"}</strong><p>Geen rayonlijnen of rayoncodes op de kaart. De backend beperkt de analyse nog steeds tot het gecontracteerde werkgebied.</p>{history && <p>Historische context: {history.source}. {history.note}</p>}</div>
      </div></aside>
    </section>
  </main>;
}

function Stat({ label, value }: { label: string; value?: number }) { return <div className="stat"><small>{label}</small><strong>{value ?? "—"}</strong></div>; }
function Filter({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) { return <button className={active ? "filter filter--active" : "filter"} onClick={onClick}>{label}</button>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div><small>{label}</small><strong>{value}</strong></div>; }