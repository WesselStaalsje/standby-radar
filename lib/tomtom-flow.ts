export type TomTomFlowSample = {
  relativeSpeed: number;
  congestionIndex: number;
  roadClosure: boolean;
  distanceMeters: number;
  roadType: string | null;
};

export type TomTomFlowResult = {
  configured: boolean;
  updatedAt: string | null;
  tileCount: number;
  samples: Map<string, TomTomFlowSample>;
  error: string | null;
};

type Point = { id: string; lat: number; lng: number };
type GeoPoint = { lat: number; lng: number };
type FlowFeature = {
  relativeSpeed: number;
  roadClosure: boolean;
  roadType: string | null;
  lines: GeoPoint[][];
};

const ZOOM = 9;
const CACHE_SECONDS = 300;
const MAX_MATCH_METERS = 900;
const ROAD_TYPES = "[0,1,2,4]";
const TAGS = "[road_type,traffic_level,traffic_road_coverage,road_closure]";

class PbfReader {
  private readonly bytes: Uint8Array;
  private pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done() { return this.pos >= this.bytes.length; }

  readVarint(): number {
    let value = 0;
    let shift = 0;
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos++];
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 49) throw new Error("PBF varint te groot");
    }
    throw new Error("Onvolledige PBF varint");
  }

  readBytes(): Uint8Array {
    const length = this.readVarint();
    const end = this.pos + length;
    if (end > this.bytes.length) throw new Error("Onvolledige PBF bytes");
    const result = this.bytes.subarray(this.pos, end);
    this.pos = end;
    return result;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  readDouble(): number {
    const end = this.pos + 8;
    if (end > this.bytes.length) throw new Error("Onvolledige PBF double");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8);
    const value = view.getFloat64(0, true);
    this.pos = end;
    return value;
  }

  readFloat(): number {
    const end = this.pos + 4;
    if (end > this.bytes.length) throw new Error("Onvolledige PBF float");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4);
    const value = view.getFloat32(0, true);
    this.pos = end;
    return value;
  }

  skip(wire: number) {
    if (wire === 0) { this.readVarint(); return; }
    if (wire === 1) { this.pos += 8; return; }
    if (wire === 2) { this.pos += this.readVarint(); return; }
    if (wire === 5) { this.pos += 4; return; }
    throw new Error(`Onbekend PBF wire type ${wire}`);
  }
}

function parseValue(bytes: Uint8Array): string | number | boolean | null {
  const reader = new PbfReader(bytes);
  let value: string | number | boolean | null = null;
  while (!reader.done) {
    const tag = reader.readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) value = reader.readString();
    else if (field === 2 && wire === 5) value = reader.readFloat();
    else if (field === 3 && wire === 1) value = reader.readDouble();
    else if ([4, 5, 6].includes(field) && wire === 0) value = reader.readVarint();
    else if (field === 7 && wire === 0) value = Boolean(reader.readVarint());
    else reader.skip(wire);
  }
  return value;
}

const zigZag = (value: number) => (value >>> 1) ^ -(value & 1);

function tilePointToLatLng(tileX: number, tileY: number, extent: number, x: number, y: number): GeoPoint {
  const n = 2 ** ZOOM;
  const worldX = (tileX + x / extent) / n;
  const worldY = (tileY + y / extent) / n;
  const lng = worldX * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI;
  return { lat, lng };
}

function decodeGeometry(bytes: Uint8Array, tileX: number, tileY: number, extent: number): GeoPoint[][] {
  const reader = new PbfReader(bytes);
  const lines: GeoPoint[][] = [];
  let line: GeoPoint[] = [];
  let x = 0;
  let y = 0;

  while (!reader.done) {
    const commandInteger = reader.readVarint();
    const command = commandInteger & 7;
    const count = commandInteger >> 3;

    if (command === 1) {
      for (let i = 0; i < count; i++) {
        x += zigZag(reader.readVarint());
        y += zigZag(reader.readVarint());
        if (line.length) lines.push(line);
        line = [tilePointToLatLng(tileX, tileY, extent, x, y)];
      }
    } else if (command === 2) {
      for (let i = 0; i < count; i++) {
        x += zigZag(reader.readVarint());
        y += zigZag(reader.readVarint());
        line.push(tilePointToLatLng(tileX, tileY, extent, x, y));
      }
    } else if (command === 7) {
      // ClosePath is irrelevant for traffic line strings.
    } else {
      throw new Error(`Onbekend vector-tile geometry command ${command}`);
    }
  }

  if (line.length) lines.push(line);
  return lines.filter(item => item.length >= 2);
}

function parseFeature(
  bytes: Uint8Array,
  keys: string[],
  values: Array<string | number | boolean | null>,
  tileX: number,
  tileY: number,
  extent: number,
): FlowFeature | null {
  const reader = new PbfReader(bytes);
  let tagIndexes: number[] = [];
  let geometry: Uint8Array | null = null;
  let type = 0;

  while (!reader.done) {
    const tag = reader.readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      const packed = new PbfReader(reader.readBytes());
      const indexes: number[] = [];
      while (!packed.done) indexes.push(packed.readVarint());
      tagIndexes = indexes;
    } else if (field === 3 && wire === 0) type = reader.readVarint();
    else if (field === 4 && wire === 2) geometry = reader.readBytes();
    else reader.skip(wire);
  }

  if (type !== 2 || !geometry || !geometry.length) return null;

  const props: Record<string, string | number | boolean | null> = {};
  for (let i = 0; i + 1 < tagIndexes.length; i += 2) {
    const key = keys[tagIndexes[i]];
    if (key) props[key] = values[tagIndexes[i + 1]] ?? null;
  }

  const rawLevel = Number(props.traffic_level);
  if (!Number.isFinite(rawLevel)) return null;
  const relativeSpeed = Math.max(0, Math.min(1, rawLevel));
  const roadType = typeof props.road_type === "string" ? props.road_type : null;
  const roadClosure = props.road_closure === true || relativeSpeed === 0;
  const lines = decodeGeometry(geometry, tileX, tileY, extent);
  if (!lines.length) return null;

  return { relativeSpeed, roadClosure, roadType, lines };
}

function parseTile(bytes: Uint8Array, tileX: number, tileY: number): FlowFeature[] {
  const tile = new PbfReader(bytes);
  const layers: Uint8Array[] = [];

  while (!tile.done) {
    const tag = tile.readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 3 && wire === 2) layers.push(tile.readBytes());
    else tile.skip(wire);
  }

  const output: FlowFeature[] = [];
  for (const layerBytes of layers) {
    const reader = new PbfReader(layerBytes);
    let name = "";
    let extent = 4096;
    const keys: string[] = [];
    const values: Array<string | number | boolean | null> = [];
    const rawFeatures: Uint8Array[] = [];

    while (!reader.done) {
      const tag = reader.readVarint();
      const field = tag >> 3;
      const wire = tag & 7;
      if (field === 1 && wire === 2) name = reader.readString();
      else if (field === 2 && wire === 2) rawFeatures.push(reader.readBytes());
      else if (field === 3 && wire === 2) keys.push(reader.readString());
      else if (field === 4 && wire === 2) values.push(parseValue(reader.readBytes()));
      else if (field === 5 && wire === 0) extent = reader.readVarint();
      else reader.skip(wire);
    }

    if (name.toLowerCase() !== "traffic flow") continue;
    for (const raw of rawFeatures) {
      const feature = parseFeature(raw, keys, values, tileX, tileY, extent);
      if (feature) output.push(feature);
    }
  }
  return output;
}

function lonLatToTile(lng: number, lat: number) {
  const n = 2 ** ZOOM;
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

function tileRange(points: Point[]) {
  if (!points.length) return [] as Array<{ x: number; y: number }>;
  const xs = points.map(point => lonLatToTile(point.lng, point.lat).x);
  const ys = points.map(point => lonLatToTile(point.lng, point.lat).y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const result: Array<{ x: number; y: number }> = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) result.push({ x, y });
  return result;
}

function distancePointToSegmentMeters(point: GeoPoint, a: GeoPoint, b: GeoPoint) {
  const latRad = point.lat * Math.PI / 180;
  const scaleX = 111_320 * Math.cos(latRad);
  const scaleY = 110_540;
  const ax = (a.lng - point.lng) * scaleX;
  const ay = (a.lat - point.lat) * scaleY;
  const bx = (b.lng - point.lng) * scaleX;
  const by = (b.lat - point.lat) * scaleY;
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(ax, ay);
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function distanceToFeatureMeters(point: GeoPoint, feature: FlowFeature) {
  let best = Number.POSITIVE_INFINITY;
  for (const line of feature.lines) {
    for (let i = 1; i < line.length; i++) {
      best = Math.min(best, distancePointToSegmentMeters(point, line[i - 1], line[i]));
    }
  }
  return best;
}

function congestionIndex(relativeSpeed: number) {
  return Math.max(0, Math.min(100, Math.round((1 - relativeSpeed) * 100)));
}

function chooseSample(point: Point, features: FlowFeature[]): TomTomFlowSample | null {
  const nearby = features
    .map(feature => ({ feature, distance: distanceToFeatureMeters(point, feature) }))
    .filter(item => item.distance <= MAX_MATCH_METERS)
    .sort((a, b) => a.distance - b.distance);
  if (!nearby.length) return null;

  const nearestDistance = nearby[0].distance;
  const directional = nearby.filter(item => item.distance <= Math.min(MAX_MATCH_METERS, nearestDistance + 180));
  const selected = directional.sort((a, b) => {
    if (a.feature.roadClosure !== b.feature.roadClosure) return a.feature.roadClosure ? -1 : 1;
    return a.feature.relativeSpeed - b.feature.relativeSpeed;
  })[0];

  return {
    relativeSpeed: selected.feature.relativeSpeed,
    congestionIndex: congestionIndex(selected.feature.relativeSpeed),
    roadClosure: selected.feature.roadClosure,
    distanceMeters: Math.round(selected.distance),
    roadType: selected.feature.roadType,
  };
}

export function scoreTomTom(relativeSpeed: number, roadClosure: boolean) {
  if (roadClosure) return 34;
  if (relativeSpeed <= 0.30) return 32;
  if (relativeSpeed <= 0.45) return 27;
  if (relativeSpeed <= 0.60) return 21;
  if (relativeSpeed <= 0.75) return 14;
  if (relativeSpeed <= 0.85) return 8;
  if (relativeSpeed <= 0.92) return 4;
  return 0;
}

export async function fetchTomTomRelativeFlow(points: Point[], apiKey: string | undefined): Promise<TomTomFlowResult> {
  if (!apiKey) {
    return { configured: false, updatedAt: null, tileCount: 0, samples: new Map(), error: "TOMTOM_API_KEY ontbreekt" };
  }

  const tiles = tileRange(points);
  const features: FlowFeature[] = [];
  let successfulTiles = 0;
  const errors: string[] = [];

  for (let offset = 0; offset < tiles.length; offset += 4) {
    const batch = tiles.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async tile => {
      const params = new URLSearchParams({
        key: apiKey,
        roadTypes: ROAD_TYPES,
        tags: TAGS,
        trafficLevelStep: "0.01",
        margin: "0.1",
      });
      try {
        const response = await fetch(
          `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${ZOOM}/${tile.x}/${tile.y}.pbf?${params}`,
          {
            next: { revalidate: CACHE_SECONDS },
            signal: AbortSignal.timeout(8_000),
            headers: { "user-agent": "StandbyRadar/0.9" },
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { ok: true as const, features: parseTile(bytes, tile.x, tile.y) };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : "TomTom tile fout" };
      }
    }));

    for (const result of results) {
      if (result.ok) {
        successfulTiles++;
        features.push(...result.features);
      } else errors.push(result.error);
    }
  }

  const samples = new Map<string, TomTomFlowSample>();
  for (const point of points) {
    const sample = chooseSample(point, features);
    if (sample) samples.set(point.id, sample);
  }

  return {
    configured: true,
    updatedAt: new Date().toISOString(),
    tileCount: successfulTiles,
    samples,
    error: successfulTiles ? (errors.length ? `${errors.length}/${tiles.length} tiles niet beschikbaar` : null) : errors[0] ?? "Geen TomTom tiles beschikbaar",
  };
}
