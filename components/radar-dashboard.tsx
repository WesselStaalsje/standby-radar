"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import type { LiveRadarData, StandbyAdvice, TrafficKind } from "@/lib/types";

type Filters = { traffic: boolean; incidents: boolean; works: boolean; advice: boolean };

const colors: Record<TrafficKind, string> = {
  traffic: "#f1a34b",
  accident: "#e44c4c",
  obstruction: "#df7a43",
  closure: "#a84f6c",
  works: "#7a7d8b",
  weather: "#4a8db8",
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c] ?? c));

const clock = (value: string | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const scoreTone = (score: number) => score >= 80 ? "hot" : score >= 52 ? "warm" : "normal";

const visibleKind = (kind: TrafficKind, filters: Filters) => {
  if (kind === "traffic") return filters.traffic;
  if (kind === "works") return filters.works;
  return filters.incidents;
};

export function RadarDashboard() {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<LiveRadarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ traffic: true, incidents: true, works: false, advice: true });
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/live", { cache: "no-store" });
      if (!response.ok) throw new Error(`Live feed HTTP ${response.status}`);
      const payload = await response.json() as LiveRadarData;
      setData(payload);
      setError(null);
      setSelectedId((current) => current && payload.advice.some((item) => item.id === current) ? current : payload.advice[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Live data kon niet geladen worden");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), 60_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearInterval(refresh); window.clearInterval(tick); };
  }, [load]);

  useEffect(() => {
    let disposed = false;
    const init = async () => {
      if (!mapElement.current || mapRef.current) return;
      const L = await import("leaflet");
      if (disposed || !mapElement.current) return;
      leafletRef.current = L;
      const map = L.map(mapElement.current, { center: [51.75, 5.45], zoom: 8, zoomControl: false, preferCanvas: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      map.fitBounds([[51.22, 4.3], [52.25, 6.4]], { padding: [24, 24] });
      mapRef.current = map;
      setReady(true);
      setTimeout(() => map.invalidateSize(), 80);
    };
    void init();
    return () => { disposed = true; mapRef.current?.remove(); mapRef.current = null; leafletRef.current = null; layerRef.current = null; };
  }, []);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer || !data) return;
    layer.clearLayers();

    if (filters.advice) {
      for (const item of data.advice) {
        const tone = scoreTone(item.score);
        const color = tone === "hot" ? "#d74747" : tone === "warm" ? "#d79535" : "#3e956a";
        L.circle([item.lat, item.lng], { radius: 15000, weight: 2, color, opacity: .6, fillColor: color, fillOpacity: .07, interactive: false }).addTo(layer);
        const icon = L.divIcon({ className: "standby-div-icon", html: `<span class="standby-pin standby-pin--${tone}">${item.score}</span>`, iconSize: [38, 38], iconAnchor: [19, 19] });
        const marker = L.marker([item.lat, item.lng], { icon, zIndexOffset: 300 });
        marker.bindPopup(`<div class="radar-popup"><strong>${escapeHtml(item.name)} · ${item.score}/100</strong><br>${escapeHtml(item.roads.join(" · "))}<br>Advies: ${item.recommendedUnits} eenheid${item.recommendedUnits === 1 ? "" : "en"}<br>Zekerheid: ${item.confidence}</div>`);
        marker.on("click", () => setSelectedId(item.id));
        marker.addTo(layer);
      }
    }

    for (const event of data.events) {
      if (!visibleKind(event.kind, filters)) continue;
      const marker = L.circleMarker([event.lat, event.lng], { radius: event.kind === "accident" ? 8 : 6, weight: 2, color: "#fff", fillColor: colors[event.kind], fillOpacity: .94, opacity: .95 });
      const queue = event.queueLengthMeters && event.queueLengthMeters > 0 ? ` · ${(event.queueLengthMeters / 1000).toLocaleString("nl-NL", { maximumFractionDigits: 1 })} km` : "";
      marker.bindPopup(`<div class="radar-popup"><strong>${escapeHtml(event.title)}</strong><br>${escapeHtml(event.roadRef ?? "Locatie via NDW")}${queue}<br>Bron: ${escapeHtml(event.source ?? "NDW")}<br>Update: ${escapeHtml(clock(event.updatedAt))}</div>`);
      marker.addTo(layer);
    }
  }, [ready, data, filters]);

  const selected = useMemo(() => data?.advice.find((item) => item.id === selectedId) ?? data?.advice[0] ?? null, [data, selectedId]);
  const age = data ? Math.max(0, Math.floor((now - new Date(data.generatedAt).getTime()) / 1000)) : 0;
  const next = Math.max(0, (data?.refreshAfterSeconds ?? 60) - age);
  const maxMatrix = Math.max(1, ...(data?.matrix.byRoad.map((item) => item.active) ?? [1]));

  const focus = (item: StandbyAdvice) => {
    setSelectedId(item.id);
    mapRef.current?.setView([item.lat, item.lng], 11, { animate: true });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><span /></span>
          <div><strong>STANDBY RADAR</strong><small>Realtime verkeersbeeld & bergingsadvies</small></div>
        </div>
        <div className="topbar-right">
          <span className="scope">NOORD-BRABANT + GELDERLAND</span>
          <span className="update">{data ? `live ${clock(data.generatedAt)} · ${next}s` : "verbinden…"}</span>
          <button onClick={() => void load(true)} disabled={refreshing}>{refreshing ? "VERVERSEN…" : "NU VERVERSEN"}</button>
        </div>
      </header>

      <section className="workspace">
        <div className="map-panel">
          <div ref={mapElement} className="map" aria-label="Realtime verkeerskaart Brabant en Gelderland" />
          {loading && <div className="loading-card">LIVE BRONNEN LADEN…</div>}
          <div className="map-hud">
            <div className="stats">
              <Stat label="Actuele signalen" value={data?.meta.eventCount} />
              <Stat label="Ongevallen" value={data?.meta.accidentCount} />
              <Stat label="Blokkades" value={data?.meta.obstructionCount} />
              <Stat label="Matrixacties" value={data?.matrix.activeSignals} />
            </div>
            <div className="filters">
              <Filter label="Verkeer" active={filters.traffic} onClick={() => setFilters((f) => ({ ...f, traffic: !f.traffic }))} />
              <Filter label="Incidenten" active={filters.incidents} onClick={() => setFilters((f) => ({ ...f, incidents: !f.incidents }))} />
              <Filter label="Werkzaamheden" active={filters.works} onClick={() => setFilters((f) => ({ ...f, works: !f.works }))} />
              <Filter label="Stand-by zones" active={filters.advice} onClick={() => setFilters((f) => ({ ...f, advice: !f.advice }))} />
            </div>
          </div>
          <div className="legend">
            <span><i className="dot accident" /> Ongeval</span>
            <span><i className="dot obstruction" /> Obstakel</span>
            <span><i className="dot traffic" /> Vertraging</span>
            <span><i className="ring" /> Advieszone</span>
          </div>
        </div>

        <aside className="sidebar">
          <div className="side-scroll">
            {error && <div className="error-card">{error}</div>}
            <section className="block">
              <div className="block-title"><strong>BRONSTATUS</strong><span>{data?.sources.filter((s) => s.ok).length ?? 0}/{data?.sources.length ?? 3} online</span></div>
              <div className="sources">{data?.sources.map((source) => <span key={source.id} className={source.ok ? "source source--ok" : "source"} title={source.error ?? source.updatedAt ?? source.name}>{source.name}</span>)}</div>
            </section>

            <section className="block">
              <div className="block-title"><strong>AANBEVOLEN STAND-BY</strong><span>{data?.meta.rushHour ? "spits" : "normaal"}</span></div>
              <div className="advice-list">{data?.advice.slice(0, 7).map((item, index) => (
                <button key={item.id} className={`advice-card ${selected?.id === item.id ? "advice-card--selected" : ""}`} onClick={() => focus(item)}>
                  <span className={`score score--${scoreTone(item.score)}`}>{item.score}</span>
                  <span className="advice-copy"><strong>{index + 1}. {item.name}<em>{item.recommendedUnits}×</em></strong><small>{item.roads.join(" · ")} · zekerheid {item.confidence}</small><span>{item.reasons[0]}</span></span>
                </button>
              ))}</div>
            </section>

            {selected && <section className="why-card">
              <div className="why-heading"><div><small>WAAROM DIT ADVIES?</small><strong>{selected.name}</strong></div><b>{selected.score}</b></div>
              <div className="why-grid"><Metric label="Eenheden" value={selected.recommendedUnits} /><Metric label="Live signalen" value={selected.nearbyEvents} /><Metric label="Matrixclusters" value={selected.matrixClusters} /><Metric label="Zekerheid" value={selected.confidence} /></div>
              <ul>{selected.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              <p>Dit is een corridoradvies. Exacte veilige parkeer-/standplaatsen worden in de volgende laag gevalideerd.</p>
            </section>}

            <section className="block">
              <div className="block-title"><strong>MATRIXSIGNALEN</strong><span>NDW / RWS</span></div>
              <div className="matrix-list">{data?.matrix.byRoad.slice(0, 10).map((row) => <div className="matrix-row" key={row.road}><strong>{row.road}</strong><span className="matrix-track"><i style={{ width: `${Math.max(4, row.active / maxMatrix * 100)}%` }} /></span><small>{row.active} · ×{row.closures} · ≤70 {row.lowSpeed}</small></div>)}</div>
            </section>

            <div className="disclaimer"><strong>MODEL {data?.meta.modelVersion ?? "0.1"}</strong><p>{data?.meta.note ?? "Live analyse wordt geladen."}</p></div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value?: number }) { return <div className="stat"><small>{label}</small><strong>{value ?? "—"}</strong></div>; }
function Filter({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) { return <button className={active ? "filter filter--active" : "filter"} onClick={onClick}>{label}</button>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
