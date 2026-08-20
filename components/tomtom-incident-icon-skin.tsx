"use client";

import { useEffect } from "react";

type SpriteEntry = { width: number; height: number; x: number; y: number; pixelRatio?: number };
type SpriteMeta = Record<string, SpriteEntry>;
type IncidentType = "accident" | "breakdown" | "obstruction" | "traffic" | "works" | "closure" | "weather";

const TOMTOM_ICON: Record<IncidentType, string> = {
  accident: "traffic_queueing_accident",
  breakdown: "traffic_queueing_stationary_vehicle",
  obstruction: "traffic_queueing_danger",
  traffic: "traffic_queueing_jam",
  works: "traffic_queueing_roadworks",
  closure: "traffic_road_closed",
  weather: "traffic_queueing_weather_rain",
};

function loadImageSize(src: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = src;
  });
}

export function TomTomIncidentIconSkin() {
  useEffect(() => {
    let cancelled = false;
    const styleId = "tomtom-incident-icon-skin";
    void (async () => {
      try {
        const spriteResponse = await fetch("/api/tomtom-assets/sprite-json", { cache: "force-cache" });
        if (!spriteResponse.ok) return;
        const meta = await spriteResponse.json() as SpriteMeta;
        const spriteUrl = "/api/tomtom-assets/sprite-png";
        const atlas = await loadImageSize(spriteUrl);
        if (cancelled || !atlas.width || !atlas.height) return;

        const rules: string[] = [];
        (Object.keys(TOMTOM_ICON) as IncidentType[]).forEach(type => {
          const item = meta[TOMTOM_ICON[type]];
          if (!item) return;
          const ratio = Math.min(1, 20 / Math.max(item.width, item.height));
          const width = Math.max(10, Math.round(item.width * ratio * 100) / 100);
          const height = Math.max(10, Math.round(item.height * ratio * 100) / 100);
          const bgWidth = Math.round(atlas.width * ratio * 100) / 100;
          const bgHeight = Math.round(atlas.height * ratio * 100) / 100;
          const x = Math.round(item.x * ratio * 100) / 100;
          const y = Math.round(item.y * ratio * 100) / 100;
          const selectors = `.event-pin--${type}::before,.legend-icon--${type}::before`;
          rules.push(`.event-pin--${type}>svg,.legend-icon--${type}>svg{display:none!important}`);
          rules.push(`.event-pin--${type}{background:transparent!important;border-color:transparent!important;box-shadow:none!important}`);
          rules.push(`${selectors}{content:"";display:block;width:${width}px;height:${height}px;background-image:url("${spriteUrl}");background-repeat:no-repeat;background-size:${bgWidth}px ${bgHeight}px;background-position:-${x}px -${y}px}`);
        });

        if (!rules.length || cancelled) return;
        document.getElementById(styleId)?.remove();
        const styleElement = document.createElement("style");
        styleElement.id = styleId;
        styleElement.textContent = rules.join("\n");
        document.head.appendChild(styleElement);
      } catch {
        // Existing SVG markers remain as a fallback when TomTom sprites are unavailable.
      }
    })();
    return () => {
      cancelled = true;
      document.getElementById(styleId)?.remove();
    };
  }, []);

  return null;
}
