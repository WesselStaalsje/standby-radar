"use client";

import { useEffect } from "react";

type SpriteEntry = { width: number; height: number; x: number; y: number; pixelRatio?: number };
type SpriteMeta = Record<string, SpriteEntry>;
type IncidentType = "accident" | "breakdown" | "obstruction" | "traffic" | "works" | "closure" | "weather";

const CATEGORY: Record<IncidentType, number> = {
  accident: 1,
  obstruction: 3,
  weather: 4,
  traffic: 6,
  closure: 8,
  works: 9,
  breakdown: 14,
};

const FALLBACK_WORDS: Record<IncidentType, string[]> = {
  accident: ["accident", "collision"],
  breakdown: ["broken", "breakdown", "vehicle"],
  obstruction: ["danger", "hazard", "obstacle", "object"],
  traffic: ["jam", "traffic"],
  works: ["roadwork", "road-work", "works", "construction"],
  closure: ["road-closed", "roadclosed", "closure", "closed"],
  weather: ["rain", "weather", "fog"],
};

function evaluate(expr: unknown, props: Record<string, unknown>): unknown {
  if (!Array.isArray(expr)) return expr;
  if (!expr.length) return null;
  const op = expr[0];
  if (op === "literal") return expr[1];
  if (op === "get") return props[String(expr[1])];
  if (op === "image") return evaluate(expr[1], props);
  if (op === "to-string") return String(evaluate(expr[1], props) ?? "");
  if (op === "concat") return expr.slice(1).map(part => String(evaluate(part, props) ?? "")).join("");
  if (op === "coalesce") {
    for (const part of expr.slice(1)) {
      const value = evaluate(part, props);
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return null;
  }
  if (op === "==") return evaluate(expr[1], props) === evaluate(expr[2], props);
  if (op === "!=") return evaluate(expr[1], props) !== evaluate(expr[2], props);
  if (op === "in") {
    const needle = evaluate(expr[1], props);
    const haystack = evaluate(expr[2], props);
    return Array.isArray(haystack) ? haystack.includes(needle) : false;
  }
  if (op === "match") {
    const input = evaluate(expr[1], props);
    for (let index = 2; index < expr.length - 1; index += 2) {
      const label = evaluate(expr[index], props);
      const matches = Array.isArray(label) ? label.includes(input) : label === input;
      if (matches) return evaluate(expr[index + 1], props);
    }
    return evaluate(expr[expr.length - 1], props);
  }
  if (op === "case") {
    for (let index = 1; index < expr.length - 1; index += 2) {
      if (evaluate(expr[index], props)) return evaluate(expr[index + 1], props);
    }
    return evaluate(expr[expr.length - 1], props);
  }
  if (op === "step") {
    const input = Number(evaluate(expr[1], props));
    let output = evaluate(expr[2], props);
    for (let index = 3; index < expr.length; index += 2) {
      const stop = Number(evaluate(expr[index], props));
      if (input < stop) break;
      output = evaluate(expr[index + 1], props);
    }
    return output;
  }
  return null;
}

function iconNameFromStyle(style: any, category: number, meta: SpriteMeta) {
  const props: Record<string, unknown> = {
    icon_category: category,
    iconCategory: category,
    magnitude_of_delay: 2,
    magnitudeOfDelay: 2,
    left_hand_traffic: false,
  };
  for (const layer of Array.isArray(style?.layers) ? style.layers : []) {
    const expression = layer?.layout?.["icon-image"];
    if (expression === undefined) continue;
    const value = evaluate(expression, props);
    if (typeof value === "string" && meta[value]) return value;
  }
  return null;
}

function fallbackIconName(type: IncidentType, meta: SpriteMeta) {
  const keys = Object.keys(meta);
  for (const word of FALLBACK_WORDS[type]) {
    const found = keys.find(key => key.toLowerCase().includes(word));
    if (found) return found;
  }
  return null;
}

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
        const [styleResponse, spriteResponse] = await Promise.all([
          fetch("/api/tomtom-assets/style", { cache: "force-cache" }),
          fetch("/api/tomtom-assets/sprite-json", { cache: "force-cache" }),
        ]);
        if (!styleResponse.ok || !spriteResponse.ok) return;
        const [style, meta] = await Promise.all([styleResponse.json(), spriteResponse.json() as Promise<SpriteMeta>]);
        const spriteUrl = "/api/tomtom-assets/sprite-png";
        const atlas = await loadImageSize(spriteUrl);
        if (cancelled || !atlas.width || !atlas.height) return;

        const rules: string[] = [];
        (Object.keys(CATEGORY) as IncidentType[]).forEach(type => {
          const name = iconNameFromStyle(style, CATEGORY[type], meta) ?? fallbackIconName(type, meta);
          if (!name) return;
          const item = meta[name];
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
        // The existing SVG markers stay active if TomTom Assets is unavailable.
      }
    })();
    return () => {
      cancelled = true;
      document.getElementById(styleId)?.remove();
    };
  }, []);

  return null;
}
