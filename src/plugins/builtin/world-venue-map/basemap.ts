/**
 * Land and borders under the desktop and web map: Natural Earth 1:50m for the
 * whole world, and 1:10m tiles for the part in view once the map is zoomed in.
 * Both are lazy chunks (see `natural-earth/`), so the app bundle carries
 * neither. Only the desktop and web builds say where they are; the terminal,
 * which draws its own outline, has nothing to load and bundles none of it.
 *
 * Paths are in degrees, x east and y south (minus the latitude), so the map
 * places every path with one transform and pan or zoom rebuilds nothing.
 */

/** What a generated chunk exports: coordinates as integers of `STEP` degrees, polyline-encoded. */
export interface BasemapChunk {
  STEP: number;
  LAND: string;
  BORDERS: string;
}

/** West, south, east, north in degrees. */
export type GeoBox = readonly [number, number, number, number];

export interface DetailTile {
  id: string;
  /** What the tile was cut to: its square, a hair wider so neighbours overlap. */
  box: GeoBox;
  load: () => Promise<BasemapChunk>;
}

export interface BasemapPaths {
  /** Land rings, filled even-odd so lakes stay open. */
  land: string;
  /** The same rings without the edges a tile, the date line or the map's southern edge cut. */
  coast: string;
  borders: string;
}

/** The map stops at 60°S; the 1:50m chunk is cut there. */
const WORLD_BOX: GeoBox = [-180, -60, 180, 90];

/**
 * Pixels per degree where 1:10m takes over: a view about 30 degrees wide on
 * a laptop. 1:50m keeps about a fiftieth of a degree, so closer in its
 * coastlines turn into straight runs; further out 1:10m only costs paint.
 */
export const DETAIL_MIN_PX_PER_DEGREE = 32;
/** Below this the world is far enough out for a faint graticule to help. */
export const GRATICULE_MAX_PX_PER_DEGREE = 4.5;
/** Tiles decoded and kept; a long session over many seas drops the oldest. */
export const TILE_CACHE_SIZE = 40;

export type BasemapLevel = "world" | "detail";

export function basemapLevel(pxPerDegree: number): BasemapLevel {
  return pxPerDegree >= DETAIL_MIN_PX_PER_DEGREE ? "detail" : "world";
}

/** Decodes a chunk's rings or lines into flat integer runs: x0, y0, x1, y1... */
export function decodeParts(text: string): Int32Array[] {
  if (!text) return [];
  return text.split(" ").map((part) => {
    const values: number[] = [];
    let index = 0;
    let lon = 0;
    let lat = 0;
    let axis = 0;
    while (index < part.length) {
      let shift = 0;
      let bits = 0;
      let byte = 0;
      do {
        byte = part.charCodeAt(index++) - 63;
        bits |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < part.length);
      const delta = bits & 1 ? ~(bits >> 1) : bits >> 1;
      if (axis === 0) {
        lon += delta;
        values.push(lon);
      } else {
        lat += delta;
        values.push(lat);
      }
      axis ^= 1;
    }
    return Int32Array.from(values);
  });
}

function onCutEdge(x1: number, y1: number, x2: number, y2: number, box: readonly number[]): boolean {
  return (x1 === x2 && (x1 === box[0] || x1 === box[2])) || (y1 === y2 && (y1 === box[1] || y1 === box[3]));
}

/** Builds the land, coast and border paths of one chunk cut to `box`. */
export function basemapPaths(chunk: BasemapChunk, box: GeoBox): BasemapPaths {
  const scale = Math.round(1 / chunk.STEP);
  const cut = box.map((value) => Math.round(value * scale));
  const x = (value: number) => value / scale;
  const y = (value: number) => -value / scale;
  let land = "";
  let coast = "";
  for (const ring of decodeParts(chunk.LAND)) {
    const count = ring.length / 2;
    if (count < 3) continue;
    land += `M${x(ring[0]!)} ${y(ring[1]!)}`;
    for (let index = 1; index < count; index += 1) land += `L${x(ring[index * 2]!)} ${y(ring[index * 2 + 1]!)}`;
    land += "Z";
    let drawing = false;
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      const x1 = ring[index * 2]!;
      const y1 = ring[index * 2 + 1]!;
      const x2 = ring[next * 2]!;
      const y2 = ring[next * 2 + 1]!;
      if (onCutEdge(x1, y1, x2, y2, cut)) {
        drawing = false;
        continue;
      }
      if (!drawing) coast += `M${x(x1)} ${y(y1)}`;
      coast += `L${x(x2)} ${y(y2)}`;
      drawing = true;
    }
  }
  let borders = "";
  for (const line of decodeParts(chunk.BORDERS)) {
    for (let index = 0; index < line.length; index += 2) borders += `${index ? "L" : "M"}${x(line[index]!)} ${y(line[index + 1]!)}`;
  }
  return { land, coast, borders };
}

/** Tiles under the view, with a margin either side so a pan finds its tiles loaded. */
export function tilesInView(tiles: readonly DetailTile[], view: GeoBox, margin = 0.15): DetailTile[] {
  const padX = (view[2] - view[0]) * margin;
  const padY = (view[3] - view[1]) * margin;
  const west = view[0] - padX;
  const south = view[1] - padY;
  const east = view[2] + padX;
  const north = view[3] + padY;
  return tiles.filter(({ box }) => box[0] < east && box[2] > west && box[1] < north && box[3] > south);
}

/** A country name at its label point, with the web-map zoom it first shows at and its rank. */
export type CountryLabel = readonly [name: string, longitude: number, latitude: number, minZoom: number, rank: number];

/** What `natural-earth/index.chunk.ts` exports. */
interface BasemapIndex {
  loadWorld: () => Promise<BasemapChunk>;
  loadLabels: () => Promise<{ COUNTRY_LABELS: readonly CountryLabel[] }>;
  DETAIL_TILES: readonly DetailTile[];
}

/**
 * `./natural-earth/index.chunk.js` in the desktop and web builds, which ship
 * the chunks beside the app; absent everywhere else. Written as the import's
 * own specifier so a build without it has no path to follow into the data.
 */
declare const __GLOOM_WORLD_MAP_DATA__: string | undefined;

let indexModule: Promise<BasemapIndex> | null = null;
let worldPaths: Promise<BasemapPaths> | null = null;
const tilePaths = new Map<string, Promise<BasemapPaths>>();

function loadIndex(): Promise<BasemapIndex> {
  if (typeof __GLOOM_WORLD_MAP_DATA__ !== "string") return Promise.reject(new Error("No map data in this build"));
  indexModule ??= (import(__GLOOM_WORLD_MAP_DATA__) as Promise<BasemapIndex>).catch((error: unknown) => {
    indexModule = null;
    throw error;
  });
  return indexModule;
}

export function loadWorldBasemap(): Promise<BasemapPaths> {
  worldPaths ??= loadIndex()
    .then((index) => index.loadWorld())
    .then((chunk) => basemapPaths(chunk, WORLD_BOX))
    .catch((error: unknown) => {
      worldPaths = null;
      throw error;
    });
  return worldPaths;
}

let countryLabels: Promise<readonly CountryLabel[]> | null = null;

/** Country names, most prominent first; a lazy chunk like the land. */
export function loadCountryLabels(): Promise<readonly CountryLabel[]> {
  countryLabels ??= loadIndex()
    .then((index) => index.loadLabels())
    .then((chunk) => chunk.COUNTRY_LABELS)
    .catch((error: unknown) => {
      countryLabels = null;
      throw error;
    });
  return countryLabels;
}

export function loadDetailIndex(): Promise<readonly DetailTile[]> {
  return loadIndex().then((index) => index.DETAIL_TILES);
}

/**
 * Decoding a tile takes a few milliseconds; a view that needs twenty would
 * hold a frame for a quarter of a second. They take turns, one per task.
 */
let decodeQueue: Promise<unknown> = Promise.resolve();

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function loadDetailTile(tile: DetailTile): Promise<BasemapPaths> {
  const cached = tilePaths.get(tile.id);
  if (cached) {
    // Most recently used last, so the oldest is the first to go.
    tilePaths.delete(tile.id);
    tilePaths.set(tile.id, cached);
    return cached;
  }
  const pending = tile.load()
    .then((chunk) => {
      const decoded = decodeQueue.then(nextTask).then(() => basemapPaths(chunk, tile.box));
      decodeQueue = decoded.catch(() => {});
      return decoded;
    })
    .catch((error: unknown) => {
      tilePaths.delete(tile.id);
      throw error;
    });
  tilePaths.set(tile.id, pending);
  while (tilePaths.size > TILE_CACHE_SIZE) tilePaths.delete(tilePaths.keys().next().value!);
  return pending;
}

