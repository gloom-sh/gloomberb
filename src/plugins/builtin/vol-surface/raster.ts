import type { NativeChartBitmap } from "../../../components/chart/native/chart-rasterizer";
import type { ResolvedChartPalette } from "../../../components/chart/core/palette";
import {
  blendPixel, clamp, drawCircle, drawLine, fillOpaque, fillRect, parseHex, type RgbaColor,
} from "../../../components/chart/native/raster/primitives";
import { blendHex } from "../../../theme/color-utils";
import { buildSurfaceMesh, surfaceMeshBoundary, surfaceMeshEdgeKey } from "./mesh";

/** Row-major decimal IV. Missing cells remain holes, including across tenors. */
export interface VolatilitySurfaceGrid {
  tenors: readonly number[];
  /** Forward moneyness K/F, with a value of one marking the ATM-forward ridge. */
  moneyness: readonly number[];
  volatilities: readonly (readonly (number | null)[])[];
}

export interface SurfaceCamera { azimuth: number; elevation: number; zoom: number }
export interface SurfaceCell { tenorIndex: number; moneynessIndex: number }
export interface SurfacePoint { x: number; y: number; depth: number }
export interface ProjectedSurfaceCell extends SurfacePoint, SurfaceCell { volatility: number }
export interface SurfaceLabel { text: string; x: number; y: number }
export interface VolatilitySurfaceScene {
  bitmap: NativeChartBitmap;
  projectedCells: ProjectedSurfaceCell[];
  labels: SurfaceLabel[];
  faceCount: number;
}
interface WorldPoint { x: number; y: number; z: number }
interface SurfaceVertex extends ProjectedSurfaceCell { world: WorldPoint; color: RgbaColor }

export const DEFAULT_SURFACE_CAMERA: Readonly<SurfaceCamera> = { azimuth: -0.67, elevation: 0.82, zoom: 1 };

export function clampSurfaceCamera(camera: SurfaceCamera): SurfaceCamera {
  const azimuth = Number.isFinite(camera.azimuth) ? camera.azimuth : DEFAULT_SURFACE_CAMERA.azimuth;
  return {
    azimuth: Math.atan2(Math.sin(azimuth), Math.cos(azimuth)),
    elevation: clamp(Number.isFinite(camera.elevation) ? camera.elevation : DEFAULT_SURFACE_CAMERA.elevation, 0.16, 1.35),
    zoom: clamp(Number.isFinite(camera.zoom) ? camera.zoom : 1, 0.55, 1.75),
  };
}

export function rotateSurfaceCamera(camera: SurfaceCamera, azimuthDelta: number, elevationDelta: number): SurfaceCamera {
  return clampSurfaceCamera({ ...camera, azimuth: camera.azimuth + azimuthDelta, elevation: camera.elevation + elevationDelta });
}

export function zoomSurfaceCamera(camera: SurfaceCamera, factor: number): SurfaceCamera {
  return clampSurfaceCamera({ ...camera, zoom: camera.zoom * factor });
}

/** Fixed camera distance keeps every normalized point in front of the near plane. */
function surfaceProjector(width: number, height: number, input: SurfaceCamera, boundsPoints?: WorldPoint[]): (point: WorldPoint) => SurfacePoint {
  const camera = clampSurfaceCamera(input);
  const sin = Math.sin(camera.azimuth), cos = Math.cos(camera.azimuth);
  const raw = (point: WorldPoint) => {
    const across = point.x * cos - point.y * sin;
    const along = point.x * sin + point.y * cos;
    const vertical = point.z * Math.cos(camera.elevation) - along * Math.sin(camera.elevation);
    const depth = along * Math.cos(camera.elevation) + point.z * Math.sin(camera.elevation);
    const perspective = 5.8 / Math.max(0.5, 5.8 - depth);
    return { x: across * perspective, y: -vertical * perspective, depth };
  };
  const bounds = boundsPoints?.map(raw) ?? [-1.35, 1.35].flatMap((x) => [-1.1, 1.1].flatMap((y) => [-0.65, 1].map((z) => raw({ x, y, z }))));
  const minX = Math.min(...bounds.map((point) => point.x)), maxX = Math.max(...bounds.map((point) => point.x));
  const minY = Math.min(...bounds.map((point) => point.y)), maxY = Math.max(...bounds.map((point) => point.y));
  const scale = Math.min(width * 0.78 / (maxX - minX), height * 0.76 / (maxY - minY)) * camera.zoom;
  return (point) => {
    const projected = raw(point);
    return { x: width * 0.53 + (projected.x - (minX + maxX) / 2) * scale,
      y: height * 0.46 + (projected.y - (minY + maxY) / 2) * scale, depth: projected.depth };
  };
}

export function projectSurfacePoint(point: WorldPoint, width: number, height: number, camera: SurfaceCamera): SurfacePoint {
  return surfaceProjector(width, height, camera)(point);
}

function interpolateColor(a: RgbaColor, b: RgbaColor, weight: number): RgbaColor {
  return { r: a.r + (b.r - a.r) * weight, g: a.g + (b.g - a.g) * weight,
    b: a.b + (b.b - a.b) * weight, a: 255 };
}

/** Cool to warm encodes absolute IV within this surface's displayed range. */
export function surfaceVolatilityColor(volatility: number, low: number, high: number, palette: ResolvedChartPalette): RgbaColor {
  const fraction = clamp((volatility - low) / Math.max(high - low, 1e-8), 0, 1);
  const blue = parseHex(blendHex(palette.crosshairColor, "#426be3", 0.74));
  const cyan = parseHex(blendHex(palette.candleUp, "#44d0c8", 0.76));
  const amber = parseHex(blendHex(palette.candleDown, "#f1bf70", 0.84));
  return fraction < 0.52 ? interpolateColor(blue, cyan, fraction / 0.52)
    : interpolateColor(cyan, amber, (fraction - 0.52) / 0.48);
}

// Small bitmap letters keep axis text identical in kitty and canvas. They are
// image pixels, never cell-character geometry on the desktop renderer.
const GLYPHS: Record<string, string> = {
  "0": "01110/10001/10011/10101/11001/10001/01110", "1": "00100/01100/00100/00100/00100/00100/01110",
  "2": "01110/10001/00001/00010/00100/01000/11111", "3": "11110/00001/00001/01110/00001/00001/11110",
  "4": "00010/00110/01010/10010/11111/00010/00010", "5": "11111/10000/10000/11110/00001/00001/11110",
  "6": "01110/10000/10000/11110/10001/10001/01110", "7": "11111/00001/00010/00100/01000/01000/01000",
  "8": "01110/10001/10001/01110/10001/10001/01110", "9": "01110/10001/10001/01111/00001/00001/01110",
  A: "01110/10001/10001/11111/10001/10001/10001", D: "11110/10001/10001/10001/10001/10001/11110",
  F: "11111/10000/10000/11110/10000/10000/10000",
  E: "11111/10000/10000/11110/10000/10000/11111", I: "01110/00100/00100/00100/00100/00100/01110",
  K: "10001/10010/10100/11000/10100/10010/10001", M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/11001/10101/10011/10011/10001", O: "01110/10001/10001/10001/10001/10001/01110",
  R: "11110/10001/10001/11110/10100/10010/10001", S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100", V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/10101/01010", Y: "10001/10001/01010/00100/00100/00100/00100",
  "%": "11001/11001/00010/00100/01000/10011/10011", ".": "00000/00000/00000/00000/00000/00110/00110",
  "/": "00001/00001/00010/00100/01000/10000/10000", "-": "00000/00000/00000/11111/00000/00000/00000",
};
const GLYPH_ROWS = Object.fromEntries(Object.entries(GLYPHS).map(([key, glyph]) => [key, glyph.split("/")]));

function labelWidth(text: string, scale: number): number { return Math.max(0, text.length * 6 - 1) * scale; }

function paintLabel(bitmap: NativeChartBitmap, text: string, x: number, y: number, color: RgbaColor, scale: number) {
  const left = Math.round(x), top = Math.round(y);
  for (let index = 0; index < text.length; index += 1) {
    const glyph = GLYPH_ROWS[text[index]!];
    if (!glyph) continue;
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row]![column] !== "1") continue;
        for (let sy = 0; sy < scale; sy += 1) for (let sx = 0; sx < scale; sx += 1) {
          blendPixel(bitmap.pixels, bitmap.width, bitmap.height,
            left + (index * 6 + column) * scale + sx, top + row * scale + sy, color);
        }
      }
    }
  }
}

function shadeForFace(vertices: readonly SurfaceVertex[]): number {
  const a = vertices[0]!, b = vertices[1]!, d = vertices.at(-1)!;
  const u = { x: b.world.x - a.world.x, y: b.world.y - a.world.y, z: b.world.z - a.world.z };
  const v = { x: d.world.x - a.world.x, y: d.world.y - a.world.y, z: d.world.z - a.world.z };
  const normal = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const sign = normal.z < 0 ? -1 : 1;
  const light = sign * (-normal.x * 0.32 - normal.y * 0.38 + normal.z * 0.86) / length;
  return 0.68 + 0.32 * Math.max(0, light);
}

function fillTriangle(bitmap: NativeChartBitmap, a: SurfaceVertex, b: SurfaceVertex, c: SurfaceVertex, shade: number) {
  const determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(determinant) < 1e-8) return;
  const left = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const right = Math.min(bitmap.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const top = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const bottom = Math.min(bitmap.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
    const first = ((b.y - c.y) * (x + 0.5 - c.x) + (c.x - b.x) * (y + 0.5 - c.y)) / determinant;
    const second = ((c.y - a.y) * (x + 0.5 - c.x) + (a.x - c.x) * (y + 0.5 - c.y)) / determinant;
    const third = 1 - first - second;
    if (first < -1e-8 || second < -1e-8 || third < -1e-8) continue;
    const offset = (y * bitmap.width + x) * 4;
    bitmap.pixels[offset] = Math.round((first * a.color.r + second * b.color.r + third * c.color.r) * shade);
    bitmap.pixels[offset + 1] = Math.round((first * a.color.g + second * b.color.g + third * c.color.g) * shade);
    bitmap.pixels[offset + 2] = Math.round((first * a.color.b + second * b.color.b + third * c.color.b) * shade);
    bitmap.pixels[offset + 3] = 255;
  }
}

function tenorLabel(years: number): string {
  const days = years * 365;
  if (days < 60) return `${Math.max(1, Math.round(days))}D`;
  if (days < 365) return `${Math.round(days / 30)}M`;
  return `${Number(years.toFixed(1))}Y`;
}

/** Painter-sorted shaded faces with a sparse wireframe and an explicit ATM ridge. */
export function renderVolatilitySurface(
  grid: VolatilitySurfaceGrid,
  requestedWidth: number,
  requestedHeight: number,
  palette: ResolvedChartPalette,
  camera: SurfaceCamera = DEFAULT_SURFACE_CAMERA,
  selected: SurfaceCell | null = null,
): VolatilitySurfaceScene {
  const width = clamp(Math.round(Number.isFinite(requestedWidth) ? requestedWidth : 1), 1, 4096);
  const height = clamp(Math.round(Number.isFinite(requestedHeight) ? requestedHeight : 1), 1, 4096);
  const bitmap = { width, height, pixels: new Uint8Array(width * height * 4) };
  fillOpaque(bitmap.pixels, parseHex(palette.bgColor));
  const scene: VolatilitySurfaceScene = { bitmap, projectedCells: [], labels: [], faceCount: 0 };
  const samples = grid.volatilities.flatMap((row, r) => row.flatMap((volatility, c) =>
    volatility != null && Number.isFinite(volatility) && volatility >= 0
      && Number.isFinite(grid.tenors[r]) && grid.tenors[r]! > 0
      && Number.isFinite(grid.moneyness[c]) && grid.moneyness[c]! > 0 ? [volatility] : []));
  const tenors = grid.tenors.filter((value) => Number.isFinite(value) && value > 0);
  const moneyness = grid.moneyness.filter((value) => Number.isFinite(value) && value > 0);
  if (!samples.length || !tenors.length || !moneyness.length) return scene;
  const minMoney = Math.min(...moneyness), maxMoney = Math.max(...moneyness);
  // The axis range follows the bulk of the surface; a few wild short-dated wing
  // cells poke above the box instead of flattening every other row.
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))]!;
  const minimum = quantile(0.02), maximum = quantile(0.98);
  const step = Math.max(0.01, 10 ** Math.floor(Math.log10(Math.max(0.02, maximum - minimum))) / 2);
  const lowVol = Math.max(0, Math.floor((minimum - Math.max(0.02, (maximum - minimum) * 0.14)) / step) * step);
  const highVol = Math.max(lowVol + 0.05, Math.ceil((maximum + Math.max(0.02, (maximum - minimum) * 0.08)) / step) * step);
  const worldX = (value: number) => maxMoney === minMoney ? 0 : (value - minMoney) / (maxMoney - minMoney) * 2.7 - 1.35;
  // Listed expiries are evenly spaced rows, as on a Bloomberg surface, so daily
  // front-month listings do not collapse into one ridge of the mesh.
  const rowCount = grid.tenors.length;
  const worldRow = (index: number) => rowCount <= 1 ? 0 : 1.1 - index / (rowCount - 1) * 2.2;
  const worldZ = (value: number) => clamp((value - lowVol) / (highVol - lowVol), -0.12, 1.22) * 1.65 - 0.65;
  const cameraState = clampSurfaceCamera(camera);
  const axisX = Math.cos(cameraState.azimuth) >= 0 ? -1.35 : 1.35;
  const axisY = Math.sin(cameraState.azimuth) >= 0 ? 1.1 : -1.1;
  const bounds = grid.volatilities.flatMap((row, r) => row.flatMap((volatility, c) =>
    volatility != null && Number.isFinite(volatility) && volatility >= 0
      && Number.isFinite(grid.tenors[r]) && grid.tenors[r]! > 0
      && Number.isFinite(grid.moneyness[c]) && grid.moneyness[c]! > 0
      ? [{ x: worldX(grid.moneyness[c]!), y: worldRow(r), z: worldZ(volatility) }] : []));
  bounds.push(...[-1.35, 1.35].flatMap((x) => [-1.1, 1.1].map((y) => ({ x, y, z: -0.65 }))));
  bounds.push({ x: axisX, y: axisY, z: 1 });
  const projectPoint = surfaceProjector(width, height, cameraState, bounds);
  const project = (x: number, y: number, z: number) => projectPoint({ x, y, z });
  const line = (a: SurfacePoint, b: SurfacePoint, color: RgbaColor, thickness = 1) =>
    drawLine(bitmap.pixels, width, height, a.x, a.y, b.x, b.y, color, thickness);
  const fontScale = Math.max(1, Math.min(3, Math.floor(Math.min(width / 560, height / 300))));
  const labels: { text: string; point: SurfacePoint; offsetX: number; offsetY: number; color: RgbaColor }[] = [];
  const addLabel = (text: string, point: SurfacePoint, offsetX = 0, offsetY = 0, color = parseHex(palette.axisColor)) =>
    labels.push({ text, point, offsetX, offsetY, color });
  const ground = parseHex(palette.gridColor, 0.92);
  const edge = parseHex(blendHex(palette.axisColor, palette.activeRangeColor, 0.25), 0.7);
  const amber = parseHex("#f3c47a");
  const floor = -0.65;

  // The floor is visible through missing data and anchors the three axes.
  for (let index = 0; index <= 6; index += 1) {
    const x = -1.35 + 2.7 * index / 6;
    line(project(x, -1.1, floor), project(x, 1.1, floor), ground, 0.65);
  }
  for (let index = 0; index <= 5; index += 1) {
    const y = -1.1 + 2.2 * index / 5;
    line(project(-1.35, y, floor), project(1.35, y, floor), ground, 0.65);
  }
  const corners = [project(-1.35, 1.1, floor), project(1.35, 1.1, floor), project(1.35, -1.1, floor), project(-1.35, -1.1, floor)];
  for (let index = 0; index < 4; index += 1) line(corners[index]!, corners[(index + 1) % 4]!, edge, 1);

  // Axis edges follow the camera so labels remain on the outside when rotated.
  const moneySide = Math.cos(cameraState.azimuth) >= 0 ? 1.1 : -1.1;
  const tenorSide = Math.sin(cameraState.azimuth) <= 0 ? -1.35 : 1.35;
  const zAxis = [-1.35, 1.35].flatMap((x) => [-1.1, 1.1].map((y) => ({ x, y, projected: project(x, y, floor) })))
    .sort((a, b) => a.projected.x - b.projected.x)[0]!;
  const zAnchor = zAxis.projected;
  line(zAnchor, project(zAxis.x, zAxis.y, 1), edge, 1.1);
  for (let index = 0; index <= 4; index += 1) {
    const vol = lowVol + (highVol - lowVol) * index / 4;
    const point = project(zAxis.x, zAxis.y, worldZ(vol));
    line({ ...point, x: point.x - 3 * fontScale }, point, edge, 1);
    addLabel(`${Number((vol * 100).toFixed(1))}%`, point, -9 * fontScale, -3 * fontScale);
  }
  addLabel("IV %", project(zAxis.x, zAxis.y, 1), -8 * fontScale, -19 * fontScale, parseHex(palette.activeRangeColor));
  const moneyTicks = Array.from({ length: 5 }, (_, index) => minMoney + (maxMoney - minMoney) * index / 4);
  for (const money of moneyTicks) {
    const point = project(worldX(money), moneySide, floor);
    addLabel(`${Math.round(money * 100)}%`, point, 0, 10 * fontScale);
  }
  addLabel("FORWARD MONEYNESS %", project(0, moneySide, floor), 10 * fontScale, 31 * fontScale, parseHex(palette.activeRangeColor));
  const tenorRows = [...new Set(Array.from({ length: Math.min(5, rowCount) }, (_, index) =>
    Math.round(index * (rowCount - 1) / Math.max(1, Math.min(5, rowCount) - 1))))]
    .filter((index) => Number.isFinite(grid.tenors[index]) && grid.tenors[index]! > 0);
  for (const index of tenorRows) {
    addLabel(tenorLabel(grid.tenors[index]!), project(tenorSide, worldRow(index), floor), -19 * fontScale, 8 * fontScale);
  }
  addLabel("TENOR", project(tenorSide, 0, floor), -55 * fontScale, 14 * fontScale, parseHex(palette.activeRangeColor));

  const vertices = grid.volatilities.map((row, tenorIndex) => row.map((volatility, moneynessIndex): SurfaceVertex | null => {
    const tenor = grid.tenors[tenorIndex], money = grid.moneyness[moneynessIndex];
    if (volatility == null || !Number.isFinite(volatility) || volatility < 0
      || tenor == null || !Number.isFinite(tenor) || tenor <= 0
      || money == null || !Number.isFinite(money) || money <= 0) return null;
    const world = { x: worldX(money), y: worldRow(tenorIndex), z: worldZ(volatility) };
    const cell = { ...projectPoint(world), tenorIndex, moneynessIndex, volatility };
    scene.projectedCells.push(cell);
    return { ...cell, world, color: surfaceVolatilityColor(volatility, lowVol, highVol, palette) };
  }));
  const mesh = buildSurfaceMesh(vertices.map((row) => row.map((point) => point != null)));
  const boundaryEdges = surfaceMeshBoundary(mesh);
  const faces = mesh.map((face) => {
    const points = face.vertices.map(({ row, column }) => vertices[row]![column]!);
    return { ...face, points, depth: points.reduce((sum, point) => sum + point.depth, 0) / points.length };
  });
  faces.sort((a, b) => a.depth - b.depth);
  scene.faceCount = faces.length;
  const wire = parseHex(blendHex(palette.bgColor, palette.activeRangeColor, 0.28), 0.72);
  const boundary = parseHex(blendHex(palette.bgColor, palette.activeRangeColor, 0.4), 0.75);
  const wireStep = Math.max(1, Math.round(grid.moneyness.length / 20));
  const surfacedRows = new Set<number>();
  for (const face of faces) {
    const [a, b, c] = face.points as [SurfaceVertex, SurfaceVertex, SurfaceVertex];
    const d = face.points[3];
    const shade = shadeForFace(face.points);
    fillTriangle(bitmap, a, b, c, shade);
    if (d) fillTriangle(bitmap, a, c, d, shade);
    for (let index = 0; index < face.vertices.length; index += 1) {
      const from = face.vertices[index]!, to = face.vertices[(index + 1) % face.vertices.length]!;
      const start = face.points[index]!, end = face.points[(index + 1) % face.points.length]!;
      if (boundaryEdges.has(surfaceMeshEdgeKey(from, to))) line(start, end, boundary, 0.65 * fontScale);
      else if (from.row === to.row || from.column === to.column && from.column % wireStep === 0 && from.row > to.row) line(start, end, wire, 0.65);
      surfacedRows.add(from.row);
    }
  }

  // Isolated loaded expiries remain curves while their neighbors load or fail.
  // A row that already joins the mesh keeps its wider wings as mesh edges only.
  for (let rowIndex = 0; rowIndex < vertices.length; rowIndex += 1) {
    if (surfacedRows.has(rowIndex)) continue;
    const row = vertices[rowIndex]!;
    for (let column = 0; column < row.length; column += 1) {
      const point = row[column], next = row[column + 1];
      if (!point) continue;
      if (next) line(point, next, point.color, 1.5 * fontScale);
      if (!row[column - 1] && !next) drawCircle(bitmap.pixels, width, height, point.x, point.y, 2 * fontScale, point.color);
    }
  }

  // The ATM ridge is interpolated only between adjacent valid samples.
  const atm: (SurfacePoint | null)[] = vertices.map((row) => {
    const exact = grid.moneyness.findIndex((value) => Math.abs(value - 1) < 1e-9);
    if (exact >= 0) return row[exact] ?? null;
    const high = grid.moneyness.findIndex((value) => value > 1);
    const a = row[high - 1], b = row[high];
    if (!a || !b) return null;
    const weight = (1 - grid.moneyness[high - 1]!) / (grid.moneyness[high]! - grid.moneyness[high - 1]!);
    return project(worldX(1), a.world.y, a.world.z + (b.world.z - a.world.z) * weight);
  });
  for (let row = 1; row < atm.length; row += 1) {
    const a = atm[row - 1], b = atm[row];
    if (!a || !b) continue;
    line(a, b, { ...amber, a: 32 }, 7 * fontScale);
    line(a, b, amber, 1.6 * fontScale);
  }
  const ridgeEnd = atm.toReversed().find((point) => point != null);
  if (ridgeEnd) {
    drawCircle(bitmap.pixels, width, height, ridgeEnd.x, ridgeEnd.y, 2.3 * fontScale, amber);
    addLabel("ATM", ridgeEnd, 8 * fontScale, -15 * fontScale, amber);
  }
  const chosen = selected ? vertices[selected.tenorIndex]?.[selected.moneynessIndex] : null;
  if (chosen) {
    const base = project(chosen.world.x, chosen.world.y, floor);
    const segments = Math.max(1, Math.floor(Math.hypot(base.x - chosen.x, base.y - chosen.y) / (6 * fontScale)));
    for (let index = 0; index < segments; index += 2) {
      const start = index / segments, end = Math.min(1, (index + 1) / segments);
      line({ ...chosen, x: chosen.x + (base.x - chosen.x) * start, y: chosen.y + (base.y - chosen.y) * start },
        { ...base, x: chosen.x + (base.x - chosen.x) * end, y: chosen.y + (base.y - chosen.y) * end },
        parseHex(palette.activeRangeColor, 0.42), 1);
    }
    drawCircle(bitmap.pixels, width, height, chosen.x, chosen.y, 9 * fontScale, parseHex(palette.activeRangeColor, 0.1));
    drawCircle(bitmap.pixels, width, height, chosen.x, chosen.y, 4.8 * fontScale, parseHex(palette.activeRangeColor));
    drawCircle(bitmap.pixels, width, height, chosen.x, chosen.y, 2.6 * fontScale, parseHex(palette.bgColor));
    addLabel(`${(chosen.volatility * 100).toFixed(1)}%`, chosen, 10 * fontScale, -18 * fontScale, parseHex(palette.activeRangeColor));
  }

  // Axis labels are image content, so screenshots and both hosts share typography.
  for (const item of labels) {
    let x = item.point.x + item.offsetX;
    if (item.offsetX < 0) x -= labelWidth(item.text, fontScale);
    else if (item.offsetX === 0) x -= labelWidth(item.text, fontScale) / 2;
    const y = item.point.y + item.offsetY;
    const clampedX = clamp(x, 6, Math.max(6, width - labelWidth(item.text, fontScale) - 6));
    const clampedY = clamp(y, 6, Math.max(6, height - 7 * fontScale - 6));
    scene.labels.push({ text: item.text, x: clampedX, y: clampedY });
    paintLabel(bitmap, item.text, clampedX + 1, clampedY + 1, parseHex(palette.bgColor, 0.8), fontScale);
    paintLabel(bitmap, item.text, clampedX, clampedY, item.color, fontScale);
  }
  // Compact quantitative color key, clear of the perspective plot.
  const legendWidth = Math.max(45, Math.min(170 * fontScale, width * 0.22));
  const legendX = width - legendWidth - 22 * fontScale, legendY = 19 * fontScale;
  for (let x = 0; x < legendWidth; x += 1) {
    fillRect(bitmap.pixels, width, height, legendX + x, legendY, legendX + x, legendY + 3 * fontScale,
      surfaceVolatilityColor(lowVol + (highVol - lowVol) * x / legendWidth, lowVol, highVol, palette));
  }
  paintLabel(bitmap, `${Number((lowVol * 100).toFixed(1))}%`, legendX, legendY + 9 * fontScale, parseHex(palette.axisColor), fontScale);
  const upper = `${Number((highVol * 100).toFixed(1))}%`;
  paintLabel(bitmap, upper, legendX + legendWidth - labelWidth(upper, fontScale), legendY + 9 * fontScale, parseHex(palette.axisColor), fontScale);
  return scene;
}

export function renderVolatilitySurfaceBitmap(...args: Parameters<typeof renderVolatilitySurface>): NativeChartBitmap {
  return renderVolatilitySurface(...args).bitmap;
}

/** Select the closest projected cell; camera depth breaks overlapping-point ties. */
export function hitTestSurface(scene: VolatilitySurfaceScene, x: number, y: number, radius = 18): SurfaceCell | null {
  let best: ProjectedSurfaceCell | null = null;
  let distance = radius;
  for (const point of scene.projectedCells) {
    const next = Math.hypot(point.x - x, point.y - y);
    if (next > radius) continue;
    if (next < distance - 0.5 || (Math.abs(next - distance) <= 0.5 && (!best || point.depth > best.depth))) {
      best = point;
      distance = next;
    }
  }
  return best ? { tenorIndex: best.tenorIndex, moneynessIndex: best.moneynessIndex } : null;
}
