export type ImnRoadRange = {
  rayon: string;
  road: string;
  direction: "Li" | "Re" | null;
  fromKm: number;
  toKm: number;
};

export const CURRENT_EIJCK_RAYON_FALLBACK = [
  "GL249","GL250","GL251","GL252","GL255","GL256","GL261","GL263","GL264","GL265","GL266","GL267","GL270",
  "NB296","NB297","NB299","NB300","NB302","NB303","NB304","NB305","NB306","NB307","NB311","NB312","NB321","NB323","NB325","NB326","NB327","NB329","NB331","NB333","NB334","NB335","NB336","NB337","NB338","NB339",
  "U224","U226",
] as const;

const decode = (value: string) => value
  .replace(/&amp;/g, "&")
  .replace(/&nbsp;/g, " ")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const text = (value: string) => decode(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
const num = (value: string) => {
  const parsed = Number(text(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseVanEijckRayonCodes(html: string) {
  const codes = new Set<string>();
  const row = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = row.exec(html))) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => text(cell[1]));
    if (cells.length < 2) continue;
    const code = cells[0].toUpperCase();
    const company = cells[1].toLowerCase();
    if (!/^(?:GL|NB|U)\d+[A-Z]?$/.test(code)) continue;
    if (company.includes("van eijck")) codes.add(code);
  }
  return codes.size ? [...codes].sort((a, b) => a.localeCompare(b, "nl", { numeric: true })) : [...CURRENT_EIJCK_RAYON_FALLBACK];
}

export function parseImnRoadRanges(html: string, rayonCodes: string[]) {
  const ranges: ImnRoadRange[] = [];
  for (const rayon of rayonCodes) {
    const startRx = new RegExp(`<a\\s+name=["']${rayon}["'][^>]*>`, "i");
    const startMatch = startRx.exec(html);
    if (!startMatch) continue;
    const start = startMatch.index;
    const rest = html.slice(start + startMatch[0].length);
    const next = /<a\s+name=["'][A-Z]{1,3}\d+[A-Z]?["'][^>]*>/i.exec(rest);
    const section = html.slice(start, next ? start + startMatch[0].length + next.index : html.length);

    const row = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = row.exec(section))) {
      const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1]);
      if (cells.length < 5) continue;
      const roadType = text(cells[0]).toUpperCase();
      const roadNumber = text(cells[1]).replace(/^0+/, "");
      if (roadType !== "A" || !/^\d{1,3}$/.test(roadNumber)) continue;
      const directionText = text(cells[2]);
      const direction = directionText === "Li" ? "Li" : directionText === "Re" ? "Re" : null;
      const fromKm = num(cells[3]);
      const toKm = num(cells[4]);
      if (fromKm === null || toKm === null) continue;
      ranges.push({ rayon, road: `A${Number(roadNumber)}`, direction, fromKm: Math.min(fromKm, toKm), toKm: Math.max(fromKm, toKm) });
    }
  }
  return ranges;
}

export function normalizeDirection(value: string | null | undefined): "Li" | "Re" | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "li" || v === "l" || v === "links") return "Li";
  if (v === "re" || v === "r" || v === "rechts") return "Re";
  return null;
}

export function findImnRange(
  road: string,
  km: number,
  direction: string | null | undefined,
  ranges: ImnRoadRange[],
) {
  const dir = normalizeDirection(direction);
  const candidates = ranges.filter(range => range.road === road && km >= range.fromKm && km <= range.toKm);
  if (!candidates.length) return null;
  if (dir) return candidates.find(range => range.direction === dir) ?? candidates.find(range => range.direction === null) ?? null;
  const uniqueRayons = [...new Set(candidates.map(range => range.rayon))];
  return uniqueRayons.length === 1 ? candidates[0] : null;
}

export function rangeOverlapsSegment(range: ImnRoadRange, road: string, fromKm: number, toKm: number) {
  return range.road === road && range.toKm >= fromKm && range.fromKm <= toKm;
}
