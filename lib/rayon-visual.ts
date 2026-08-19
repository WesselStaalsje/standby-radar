import { RAYON_OVERLAY_A } from "@/lib/rayon-overlay-a";
import { RAYON_OVERLAY_B } from "@/lib/rayon-overlay-b";

// Visual reference layer derived from the supplied Stichting IMN OWN overview map.
// The live engine does NOT use these pixels for incident/traffic scoping; operational
// calculations remain based on current IMN road, direction and hectometre ranges.
export const RAYON_OVERLAY_DATA_URI = `data:image/png;base64,${RAYON_OVERLAY_A}${RAYON_OVERLAY_B}`;

// Georeferenced against visible reference points in the supplied OWN overview map.
export const RAYON_OVERLAY_BOUNDS: [[number, number], [number, number]] = [
  [51.21018707256252, 3.7345411497730705],
  [52.1687934852603, 6.580052798789714],
];
