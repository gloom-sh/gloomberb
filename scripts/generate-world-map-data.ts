/**
 * Builds the world map's land and borders from Natural Earth (public domain,
 * naturalearthdata.com), pinned to a release of the official
 * natural-earth-vector repository. Writes, under the MAP plugin's natural-earth
 * folder:
 *
 * - `world-50m.chunk.ts`: 1:50m land and country borders for the whole map
 * - `tiles/*.chunk.ts`: 1:10m land and borders cut into square tiles, drawn
 *   once the map is zoomed in
 * - `index.chunk.ts`: what the map loads first, the loaders for both
 *
 * Every module is a `.chunk.ts` loaded with `import()`, so the web and desktop
 * builds ship each one as its own file, and only those builds point the map
 * at the index (see `src/renderers/dom/build-assets.ts`). The terminal, which
 * draws its own outline, neither loads nor bundles any of them.
 *
 *   bun run map:data            # downloads once into node_modules/.cache
 *   bun run map:data --source <dir with the .geojson files>
 */
import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const RELEASE = "v5.1.2";
const SOURCE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${RELEASE}/geojson`;
const FILES = {
  land50: "ne_50m_land",
  borders50: "ne_50m_admin_0_boundary_lines_land",
  land10: "ne_10m_land",
  borders10: "ne_10m_admin_0_boundary_lines_land",
} as const;

const OUT_DIR = join(process.cwd(), "src/plugins/builtin/world-venue-map/natural-earth");
/** The map stops at 60°S, as the venue map always has. */
const SOUTH = -60;
const NORTH = 90;
/** Tiles are this many degrees square, from 180°W and 60°S. */
const TILE_DEGREES = 15;
/**
 * Each tile is cut a little wider than its square, so neighbouring land
 * overlaps instead of meeting on an anti-aliased seam.
 */
const TILE_OVERLAP = 0.005;

interface Detail {
  /** Coordinates are kept as integers of this step, in degrees. */
  step: number;
  /** Douglas-Peucker tolerance in degrees, about half a pixel where the level is drawn. */
  tolerance: number;
  /** Rings smaller than this many square degrees are dropped. */
  minArea: number;
}

const WORLD: Detail = { step: 0.01, tolerance: 0.02, minArea: 0.002 };
const TILES: Detail = { step: 0.001, tolerance: 0.0025, minArea: 0.000004 };

type Point = [number, number];
type Box = [number, number, number, number];

interface GeoJson {
  features: { geometry: { type: string; coordinates: unknown } | null }[];
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function loadSource(name: string): Promise<GeoJson> {
  const sourceDir = argValue("--source") ?? join(process.cwd(), "node_modules/.cache/natural-earth", RELEASE);
  const path = join(sourceDir, `${name}.geojson`);
  if (!existsSync(path)) {
    await mkdir(sourceDir, { recursive: true });
    const response = await fetch(`${SOURCE_URL}/${name}.geojson`);
    if (!response.ok) throw new Error(`Download failed for ${name}: ${response.status}`);
    await Bun.write(path, await response.arrayBuffer());
  }
  return JSON.parse(await Bun.file(path).text()) as GeoJson;
}

/** Outer rings and holes alike: the map fills them even-odd. */
function polygonRings(source: GeoJson): Point[][] {
  const rings: Point[][] = [];
  for (const feature of source.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const polygons = geometry.type === "Polygon"
      ? [geometry.coordinates as Point[][]]
      : geometry.type === "MultiPolygon" ? geometry.coordinates as Point[][][] : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const open = ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring;
        if (open.length >= 3) rings.push(open.map(([lon, lat]) => [lon, lat]));
      }
    }
  }
  return rings;
}

function lineStrings(source: GeoJson): Point[][] {
  const lines: Point[][] = [];
  for (const feature of source.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const parts = geometry.type === "LineString"
      ? [geometry.coordinates as Point[]]
      : geometry.type === "MultiLineString" ? geometry.coordinates as Point[][] : [];
    for (const line of parts) if (line.length >= 2) lines.push(line.map(([lon, lat]) => [lon, lat]));
  }
  return lines;
}

function segmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / length));
  return Math.hypot(point[0] - (from[0] + t * dx), point[1] - (from[1] + t * dy));
}

/** Douglas-Peucker without recursion: some rings run to six figures of points. */
function simplifyOpen(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let distance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const next = segmentDistance(points[index]!, points[first]!, points[last]!);
      if (next > distance) {
        distance = next;
        farthest = index;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([first, farthest], [farthest, last]);
  }
  return points.filter((_, index) => keep[index] === 1);
}

function simplifyRing(ring: Point[], tolerance: number): Point[] {
  // Split at the point farthest from the first so both halves have fixed ends.
  let split = 0;
  let distance = -1;
  for (let index = 1; index < ring.length; index += 1) {
    const next = Math.hypot(ring[index]![0] - ring[0]![0], ring[index]![1] - ring[0]![1]);
    if (next > distance) {
      distance = next;
      split = index;
    }
  }
  if (split === 0) return ring;
  const first = simplifyOpen(ring.slice(0, split + 1), tolerance);
  const second = simplifyOpen([...ring.slice(split), ring[0]!], tolerance);
  return [...first, ...second.slice(1, -1)];
}

function clipPolygon(ring: Point[], [west, south, east, north]: Box): Point[] {
  const edges: [(point: Point) => boolean, (from: Point, to: Point) => Point][] = [
    [(point) => point[0] >= west, (from, to) => [west, from[1] + ((to[1] - from[1]) * (west - from[0])) / (to[0] - from[0])]],
    [(point) => point[0] <= east, (from, to) => [east, from[1] + ((to[1] - from[1]) * (east - from[0])) / (to[0] - from[0])]],
    [(point) => point[1] >= south, (from, to) => [from[0] + ((to[0] - from[0]) * (south - from[1])) / (to[1] - from[1]), south]],
    [(point) => point[1] <= north, (from, to) => [from[0] + ((to[0] - from[0]) * (north - from[1])) / (to[1] - from[1]), north]],
  ];
  let output = ring;
  for (const [inside, cross] of edges) {
    if (!output.length) break;
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index]!;
      const previous = input[(index + input.length - 1) % input.length]!;
      if (inside(current)) {
        if (!inside(previous)) output.push(cross(previous, current));
        output.push(current);
      } else if (inside(previous)) {
        output.push(cross(previous, current));
      }
    }
  }
  return output;
}

/** Liang-Barsky per segment, joined back into runs where the line stays inside. */
function clipLine(line: Point[], [west, south, east, north]: Box): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] | null = null;
  for (let index = 1; index < line.length; index += 1) {
    const from = line[index - 1]!;
    const to = line[index]!;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    let enter = 0;
    let leave = 1;
    let visible = true;
    for (const [p, q] of [[-dx, from[0] - west], [dx, east - from[0]], [-dy, from[1] - south], [dy, north - from[1]]] as const) {
      if (p === 0) {
        if (q < 0) visible = false;
        continue;
      }
      const t = q / p;
      if (p < 0) enter = Math.max(enter, t);
      else leave = Math.min(leave, t);
    }
    if (!visible || enter > leave) {
      run = null;
      continue;
    }
    const start: Point = [from[0] + dx * enter, from[1] + dy * enter];
    const end: Point = [from[0] + dx * leave, from[1] + dy * leave];
    if (!run || enter > 0) {
      run = [start];
      runs.push(run);
    }
    run.push(end);
    if (leave < 1) run = null;
  }
  return runs;
}

function quantize(points: Point[], step: number, closed: boolean): Point[] {
  const output: Point[] = [];
  for (const [lon, lat] of points) {
    const next: Point = [Math.round(lon / step), Math.round(lat / step)];
    const last = output.at(-1);
    if (!last || last[0] !== next[0] || last[1] !== next[1]) output.push(next);
  }
  if (closed && output.length > 1 && output[0]![0] === output.at(-1)![0] && output[0]![1] === output.at(-1)![1]) output.pop();
  return output;
}

function ringArea(ring: Point[], step: number): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[(index + 1) % ring.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2) * step * step;
}

function encodeValue(value: number): string {
  let bits = value < 0 ? ~(value << 1) : value << 1;
  let text = "";
  while (bits >= 0x20) {
    text += String.fromCharCode((0x20 | (bits & 0x1f)) + 63);
    bits >>= 5;
  }
  return text + String.fromCharCode(bits + 63);
}

/** Polyline encoding per ring or line (first point absolute), joined with spaces. */
function encode(parts: Point[][]): string {
  return parts.map((points) => {
    let lastLon = 0;
    let lastLat = 0;
    let text = "";
    for (const [lon, lat] of points) {
      text += encodeValue(lon - lastLon) + encodeValue(lat - lastLat);
      lastLon = lon;
      lastLat = lat;
    }
    return text;
  }).join(" ");
}

function boxOf(points: Point[]): Box {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of points) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

function landRings(rings: Point[][], box: Box, detail: Detail): Point[][] {
  return rings
    .map((ring) => quantize(clipPolygon(ring, box), detail.step, true))
    .filter((ring) => ring.length >= 3 && ringArea(ring, detail.step) >= detail.minArea);
}

function borderLines(lines: Point[][], box: Box, detail: Detail): Point[][] {
  return lines
    .flatMap((line) => clipLine(line, box))
    .map((line) => quantize(line, detail.step, false))
    .filter((line) => line.length >= 2);
}

const HEADER = (what: string) => `// Natural Earth ${what} (public domain). Generated by scripts/generate-world-map-data.ts; do not edit.\n`;

async function main() {
  const [land50, borders50, land10, borders10] = await Promise.all([
    loadSource(FILES.land50),
    loadSource(FILES.borders50),
    loadSource(FILES.land10),
    loadSource(FILES.borders10),
  ]);

  const worldBox: Box = [-180, SOUTH, 180, NORTH];
  const worldLand = landRings(polygonRings(land50).map((ring) => simplifyRing(ring, WORLD.tolerance)), worldBox, WORLD);
  const worldBorders = borderLines(lineStrings(borders50).map((line) => simplifyOpen(line, WORLD.tolerance)), worldBox, WORLD);
  await mkdir(join(OUT_DIR, "tiles"), { recursive: true });
  const world = [
    HEADER("1:50m land and country borders"),
    `export const STEP = ${WORLD.step};\n`,
    `export const LAND = ${JSON.stringify(encode(worldLand))};\n`,
    `export const BORDERS = ${JSON.stringify(encode(worldBorders))};\n`,
  ].join("");
  await writeFile(join(OUT_DIR, "world-50m.chunk.ts"), world);
  console.log(`world-50m: ${worldLand.length} rings, ${worldLand.reduce((sum, ring) => sum + ring.length, 0)} points, ${worldBorders.length} borders, ${world.length} bytes`);

  const rings = polygonRings(land10).map((ring) => simplifyRing(ring, TILES.tolerance));
  const lines = lineStrings(borders10).map((line) => simplifyOpen(line, TILES.tolerance));
  const ringBoxes = rings.map(boxOf);
  const lineBoxes = lines.map(boxOf);
  const overlaps = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

  for (const file of await readdir(join(OUT_DIR, "tiles"))) await rm(join(OUT_DIR, "tiles", file));
  const index: { id: string; box: Box }[] = [];
  let totalBytes = 0;
  let largest = 0;
  for (let south = SOUTH; south < NORTH; south += TILE_DEGREES) {
    for (let west = -180; west < 180; west += TILE_DEGREES) {
      const square: Box = [west, south, west + TILE_DEGREES, Math.min(NORTH, south + TILE_DEGREES)];
      const round = (value: number) => Number(value.toFixed(3));
      const box: Box = [
        round(Math.max(-180, west - TILE_OVERLAP)),
        round(Math.max(SOUTH, south - TILE_OVERLAP)),
        round(Math.min(180, square[2] + TILE_OVERLAP)),
        round(Math.min(NORTH, square[3] + TILE_OVERLAP)),
      ];
      const land = landRings(rings.filter((_, i) => overlaps(ringBoxes[i]!, box)), box, TILES);
      const borders = borderLines(lines.filter((_, i) => overlaps(lineBoxes[i]!, box)), box, TILES);
      if (!land.length && !borders.length) continue;
      const id = `${west < 0 ? "w" : "e"}${String(Math.abs(west)).padStart(3, "0")}${south < 0 ? "s" : "n"}${String(Math.abs(south)).padStart(2, "0")}`;
      const text = [
        HEADER(`1:10m land and country borders, ${west} to ${square[2]} longitude, ${south} to ${square[3]} latitude`),
        `export const STEP = ${TILES.step};\n`,
        `export const LAND = ${JSON.stringify(encode(land))};\n`,
        `export const BORDERS = ${JSON.stringify(encode(borders))};\n`,
      ].join("");
      await writeFile(join(OUT_DIR, "tiles", `${id}.chunk.ts`), text);
      index.push({ id, box });
      totalBytes += text.length;
      largest = Math.max(largest, text.length);
    }
  }
  const indexText = [
    HEADER("1:50m world and 1:10m tiles, the loaders"),
    "import type { DetailTile } from \"../basemap\";\n\n",
    "/** @knipignore Loaded through the map's data specifier, which only view builds define (see ../basemap.ts). */\n",
    "export const loadWorld = () => import(\"./world-50m.chunk.js\");\n\n",
    "export const DETAIL_TILES: readonly DetailTile[] = [\n",
    ...index.map(({ id, box }) => `  { id: "${id}", box: [${box.join(", ")}], load: () => import("./tiles/${id}.chunk.js") },\n`),
    "];\n",
  ].join("");
  await rm(join(OUT_DIR, "tiles.chunk.ts"), { force: true });
  await writeFile(join(OUT_DIR, "index.chunk.ts"), indexText);
  console.log(`tiles: ${index.length} of ${TILE_DEGREES} degrees, ${totalBytes} bytes, largest ${largest} bytes`);
}

await main();
