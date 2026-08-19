"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import type { LiveRadarData, StandbyAdvice, TrafficKind } from "@/lib/types";
import { RAYON_OVERLAY_BOUNDS, RAYON_OVERLAY_DATA_URI } from "@/lib/rayon-visual";

type Filters = { rayons: boolean; traffic: boolean; incidents: boolean; works: boolean; advice: boolean };

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

export function RadarDashboard() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const requestSeq = useRef(0);
  const lastGoodAdvice = useRef<StandbyAdvice[]>([]);
  const fittedRayons = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const [data, setData] = useState<LiveRadarData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [filters, setFilters] = useState<Filters>({ rayons: true, traffic: true, incidents: true, works: false, advice: true });

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
      const effectivePayload = effectiveAdvice === payload.advice ? payload : { ...payload, advice: effectiveAdvice };
      setData(effectivePayload);
      setSelectedId(current => current && effectiveAdvice.some(a => a.id === current) ? current : effectiveAdvice[0]?.id ?? null);

      if (shouldHaveAdvice && payload.advice.length === 0) {
        setError("Live brondata is binnen, maar de stand-byselectie leverde tijdelijk geen locaties op. De laatste geldige adviezen blijven zichtbaar.");
      } else {
        setError(null);
      }
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : "Live data kon niet geladen worden");
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [fetchPayload]);

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), 30_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, [load]);

  useEffect(() => {
    let dead = false;
    void (async () => {
      if (!mapEl.current || mapRef.current) return;
      const L = await import("leaflet");
      if (dead || !mapEl.current) return;
      leafletRef.current = L;
      const map = L.map(mapEl.current, { center: [51.75, 5.45], zoom: 8, zoomControl: false, preferCanvas: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      map.createPane("rayonPane");
      const rayonPane = map.getPane("rayonPane");
      if (rayonPane) {
        rayonPane.style.zIndex = "350";
        rayonPane.style.pointerEvents = "none";
      }
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      map.fitBounds(RAYON_OVERLAY_BOUNDS, { padding: [20, 20], maxZoom: 9 });
      mapRef.current = map;
      fittedRayons.current = true;
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 60);
    })();
    return () => {
      dead = true;
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
      layerRef.current = null;
      fittedRayons.current = false;
    };
  }, []);

  useEffect(() => {
    const L = leafletRef.current, layer = layerRef.current, map = mapRef.current;
    if (!mapReady || !L || !layer || !map || !data) return;
    layer.clearLayers();

    if (filters.rayons) {
      L.imageOverlay(RAYON_OVERLAY_DATA_URI, RAYON_OVERLAY_BOUNDS, {
        opacity: .9,
        interactive: false,
        pane: "rayonPane",
      }).addTo(layer);
      if (!fittedRayons.current) {
        map.fitBounds(RAYON_OVERLAY_BOUNDS, { padding: [28, 28], maxZoom: 9 });
        fittedRayons.current = true;
      }
    }

    if (filters.advice) {
      const best = new Map<string, StandbyAdvice>();
      for (const a of data.advice) {
        if (!best.get(a.standby.id) || (best.get(a.standby.id)?.score ?? -1) < a.score) best.set(a.standby.id, a);
      }
      for (const a of best.values()) {
        const icon = L.divIcon({
          className: "standby-div-icon",
          html: `<span class="standby-pin standby-pin--${tone(a.score)}">${a.score}</span>`,
          iconSize: [38, 38],
          iconAnchor: [19, 19],
        });
        const marker = L.marker([a.standby.lat, a.standby.lng], { icon, zIndexOffset: 300 });
        marker.bindPopup(
          `<div class="radar-popup"><strong>${esc(a.standby.name)}</strong><br>${esc(a.standby.address)}<br>${esc(locationSource(a))}` +
          `<hr><strong>${esc(a.segmentName)}</strong><br>${speedLabel(a.averageSpeedKph)} · ${flowLabel(a.flowVehiclesPerHour)}` +
          `<br>Score ${a.score}/100 · zekerheid ${esc(a.confidence)}</div>`,
        );
        marker.on("click", () => setSelectedId(a.id));
        marker.addTo(layer);
      }
    }

    for (const event of data.events) {
      if (!allow(event.kind, filters)) continue;
      const marker = L.circleMarker([event.lat, event.lng], {
        radius: event.kind === "accident" ? 8 : 6,
        weight: 2,
        color: "#fff",
        fillColor: colors[event.kind],
        fillOpacity: .92,
      });
      marker.bindPopup(
        `<div class="radar-popup"><strong>${esc(event.title)}</strong><br>${esc(event.rayon ? `${event.rayon} · ${event.roadRef ?? "IM-weg"}` : event.roadRef ?? "NDW-locatie")}` +
        `<br>Bron ${esc(event.source ?? "NDW")} · ${esc(clock(event.updatedAt))}</div>`,
      );
      marker.addTo(layer);
    }
  }, [mapReady, data, filters]);

  const selected = useMemo(() => data?.advice.find(a => a.id === selectedId) ?? data?.advice[0] ?? null, [data, selectedId]);
  const age = data ? Math.max(0, Math.floor((now - new Date(data.generatedAt).getTime()) / 1000)) : 0;
  const next = Math.max(0, (data?.refreshAfterSeconds ?? 30) - age);
  const focus = (a: StandbyAdvice) => {
    setSelectedId(a.id);
    mapRef.current?.setView([a.standby.lat, a.standby.lng], 13, { animate: true });
  };

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><span /></span><div><strong>STANDBY RADAR</strong><small>Realtime analyse uitsluitend binnen gecontracteerde IM-wegvakken</small></div></div>
      <div className="topbar-right"><span className="scope">VAN EIJCK IM-RAYONS</span><span className="update">{data ? `live ${clock(data.generatedAt)} · ${next}s` : "verbinden…"}</span><button disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "VERVERSEN…" : "NU VERVERSEN"}</button></div>
    </header>

    <section className="workspace">
      <div className="map-panel">
        <div ref={mapEl} className="map" aria-label="Standby Radar kaart" />
        {loading && <div className="loading-card">LIVE BRONNEN LADEN…</div>}

        <div className="map-hud"><div className="stats">
          <Stat label="IM-rayons" value={data?.meta.rayonCount} />
          <Stat label="5-km segmenten" value={data?.meta.segmentCount} />
          <Stat label="Verse meetpunten" value={data?.meta.measuredSiteCount} />
          <Stat label="Kandidaatplekken" value={data?.meta.candidateLocationCount} />
        </div><div className="filters">
          <Filter label="Rayons" active={filters.rayons} onClick={() => setFilters(f => ({ ...f, rayons: !f.rayons }))} />
          <Filter label="Verkeer" active={filters.traffic} onClick={() => setFilters(f => ({ ...f, traffic: !f.traffic }))} />
          <Filter label="Incidenten" active={filters.incidents} onClick={() => setFilters(f => ({ ...f, incidents: !f.incidents }))} />
          <Filter label="Werkzaamheden" active={filters.works} onClick={() => setFilters(f => ({ ...f, works: !f.works }))} />
          <Filter label="Stand-by" active={filters.advice} onClick={() => setFilters(f => ({ ...f, advice: !f.advice }))} />
        </div></div>

        <div className="legend">
          <span><i className="rayon-line" /> IMN rayonindeling</span>
          <span><i className="dot accident" /> Ongeval</span>
          <span><i className="dot obstruction" /> Obstakel</span>
          <span><i className="dot traffic" /> File</span>
          <span><i className="ring" /> Automatisch gekozen stand-byplek</span>
        </div>
      </div>

      <aside className="sidebar"><div className="side-scroll">
        {error && <div className="error-card">{error}</div>}

        <section className="block">
          <div className="block-title"><strong>IM-SCOPE</strong><span>{data?.meta.rayonCount ?? 0} rayons</span></div>
          <div className="sources">
            {data?.rayons.codes.map(code => <span key={code} className="source source--ok">{code}</span>)}
          </div>
        </section>

        <section className="block"><div className="block-title"><strong>BRONSTATUS</strong><span>{data?.sources.filter(s => s.ok).length ?? 0}/{data?.sources.length ?? 9} online</span></div><div className="sources">{data?.sources.map(s => <span key={s.id} className={s.ok ? "source source--ok" : "source"} title={`${s.lineage ?? ""}${s.updatedAt ? ` · ${clock(s.updatedAt)}` : ""}${s.error ? ` · ${s.error}` : ""}`}>{s.name}</span>)}</div></section>

        <section className="block"><div className="block-title"><strong>LIVE STAND-BYADVIES</strong><span>{data?.advice.length ?? 0} berekend</span></div><div className="advice-list">
          {data?.advice.slice(0, 12).map((a, i) => <button key={a.id} className={`advice-card ${selected?.id === a.id ? "advice-card--selected" : ""}`} onClick={() => focus(a)}>
            <span className={`score score--${tone(a.score)}`}>{a.score}</span><span className="advice-copy"><strong>{i + 1}. {a.segmentName}<em>{a.recommendedUnits}×</em></strong><small>→ {a.standby.name} · {locationSource(a)}</small><span>{speedLabel(a.averageSpeedKph)} · {flowLabel(a.flowVehiclesPerHour)} · {a.sensorCount} meetpunt(en)</span><small>{a.standby.address}</small></span>
          </button>)}
          {!loading && data && data.advice.length === 0 && <div className="error-card">Geen stand-byadviezen ontvangen terwijl er wel brondata beschikbaar is. Automatische herpoging loopt bij de volgende refresh.</div>}
        </div></section>

        {selected && <section className="why-card"><div className="why-heading"><div><small>WAAROM DEZE PLEK?</small><strong>{selected.segmentName}</strong><span className="standby-address">→ {selected.standby.name}<br />{selected.standby.address}</span></div><b>{selected.score}</b></div>
          <div className="why-grid">
            <Metric label="Rayon" value={selected.rayon} />
            <Metric label="Snelheid" value={speedLabel(selected.averageSpeedKph)} />
            <Metric label="Intensiteit" value={flowLabel(selected.flowVehiclesPerHour)} />
            <Metric label="Meetpunten" value={selected.sensorCount} />
            <Metric label="Bronbevestiging" value={`${selected.corroboratingSignals}/4`} />
            <Metric label="Matrix lokaal" value={selected.matrixClusters} />
          </div>
          <ul>{selected.reasons.map(r => <li key={r}>{r}</li>)}</ul>
          <p>{selected.standby.source === "rws" ? "Dit is een officiële RWS-locatie binnen hetzelfde IM-rayon. De engine koos hem pas nadat de actuele verkeersdruk van het wegvak was bepaald." : "Dit is een aanvullende OSM-kandidaat binnen hetzelfde IM-rayon. De plek moet operationeel geschikt en legaal toegankelijk blijven; officiële RWS-locaties krijgen voorrang."}</p>
        </section>}

        <div className="disclaimer"><strong>MODEL {data?.meta.modelVersion ?? "—"}</strong><p>{data?.meta.note ?? "Live analyse wordt geladen."}</p><p>De kaart toont de volledige rayonvormen en codes volgens de aangeleverde IMN/OWN-overzichtskaart. De live berekening zelf blijft gebaseerd op de actuele gecontracteerde IM-wegvakken, rijrichting en hectometergrenzen.</p></div>
      </div></aside>
    </section>
  </main>;
}

function Stat({ label, value }: { label: string; value?: number }) { return <div className="stat"><small>{label}</small><strong>{value ?? "—"}</strong></div>; }
function Filter({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) { return <button className={active ? "filter filter--active" : "filter"} onClick={onClick}>{label}</button>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
