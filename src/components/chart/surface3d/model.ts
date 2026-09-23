/**
 * Host-agnostic 3D surface chart. Geometry is built once per data change;
 * renderers (WebGL on desktop, the software raster in terminals) only apply a
 * camera per frame. Both use the same projection so labels and hit tests agree.
 */

export interface Surface3DCamera { azimuth: number; elevation: number; zoom: number }
export interface Surface3DCell { row: number; column: number }
export interface Surface3DTick { position: number; label: string }
export interface Surface3DColor { r: number; g: number; b: number }

export interface Surface3DInput {
  /** Row-major z values in data units; null is a hole. */
  values: readonly (readonly (number | null)[])[];
  /** Normalized 0..1 position of each column along x, and of each row along y (0 = near edge by default). */
  columnPositions: readonly number[];
  rowPositions: readonly number[];
  /** Data values at the box floor and ceiling; colour spans the same range. */
  zMin: number;
  zMax: number;
  xTicks: readonly Surface3DTick[];
  yTicks: readonly Surface3DTick[];
  zTicks: readonly { value: number; label: string }[];
  titles: { x: string; y: string; z: string };
  /** Fractional column index drawn as a highlighted ridge (for example ATM). */
  ridgeColumn?: number | null;
  ridgeLabel?: string;
  selected?: Surface3DCell | null;
  formatValue?: (value: number) => string;
}

export const X_EXTENT = 1.35;
export const Y_EXTENT = 1.1;
export const FLOOR = -0.65;
/** The colour shadow on the floor: a depth cue under the sheet, faint enough not to read as a second chart. */
export const FLOOR_PROJECTION_ALPHA = 0.16;
export const CEILING = 1;
export const DEFAULT_SURFACE3D_CAMERA: Readonly<Surface3DCamera> = { azimuth: -0.72, elevation: 0.6, zoom: 1 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function clampSurface3DCamera(camera: Surface3DCamera): Surface3DCamera {
  const azimuth = Number.isFinite(camera.azimuth) ? camera.azimuth : DEFAULT_SURFACE3D_CAMERA.azimuth;
  return {
    azimuth: Math.atan2(Math.sin(azimuth), Math.cos(azimuth)),
    elevation: clamp(Number.isFinite(camera.elevation) ? camera.elevation : DEFAULT_SURFACE3D_CAMERA.elevation, 0.12, 1.4),
    zoom: clamp(Number.isFinite(camera.zoom) ? camera.zoom : 1, 0.5, 2.4),
  };
}
export function rotateSurface3DCamera(camera: Surface3DCamera, azimuthDelta: number, elevationDelta: number): Surface3DCamera {
  return clampSurface3DCamera({ ...camera, azimuth: camera.azimuth + azimuthDelta, elevation: camera.elevation + elevationDelta });
}
export function zoomSurface3DCamera(camera: Surface3DCamera, factor: number): Surface3DCamera {
  return clampSurface3DCamera({ ...camera, zoom: camera.zoom * factor });
}

/** Turbo (Mikhailov, Google 2019), trimmed at both dark ends for a dark background. Components 0..1. */
export function turbo(fraction: number): Surface3DColor {
  const t = 0.07 + clamp(Number.isFinite(fraction) ? fraction : 0, 0, 1) * 0.87;
  return {
    r: clamp(0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943)))), 0, 1),
    g: clamp(0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604)))), 0, 1),
    b: clamp(0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973)))), 0, 1),
  };
}

/** Screen projection terms. `zoomFit` and `center` place the box in the viewport. */
export interface Surface3DViewport {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  centerX: number;
  centerY: number;
  sinA: number; cosA: number; sinE: number; cosE: number;
}
const PERSPECTIVE = 5.8;

function rawProject(point: { x: number; y: number; z: number }, v: Pick<Surface3DViewport, "sinA" | "cosA" | "sinE" | "cosE">) {
  const across = point.x * v.cosA - point.y * v.sinA;
  const along = point.x * v.sinA + point.y * v.cosA;
  const vertical = point.z * v.cosE - along * v.sinE;
  const depth = along * v.cosE + point.z * v.sinE;
  const perspective = PERSPECTIVE / Math.max(0.5, PERSPECTIVE - depth);
  return { x: across * perspective, y: -vertical * perspective, depth };
}

/**
 * Fits the box (and any spike above it) into the viewport. The fit ignores
 * zoom-independent rotation drift: bounds are the eight box corners, so the
 * chart does not jump in size while it turns.
 */
export function surface3DViewport(width: number, height: number, input: Surface3DCamera, top = CEILING, reserveRight = 0): Surface3DViewport {
  const camera = clampSurface3DCamera(input);
  const terms = { sinA: Math.sin(camera.azimuth), cosA: Math.cos(camera.azimuth), sinE: Math.sin(camera.elevation), cosE: Math.cos(camera.elevation) };
  // Rotation-invariant fit: the bounding sphere of the box keeps scale steady while turning.
  const radius = Math.hypot(X_EXTENT, Y_EXTENT, (Math.max(top, CEILING) - FLOOR) / 2);
  const usable = width * (1 - reserveRight);
  // The box never fills its bounding sphere, so a little overfill keeps it large without clipping while turning.
  const scale = Math.min(usable * 0.86, height * 0.9) / (2 * radius) * 1.1 * camera.zoom;
  const middle = rawProject({ x: 0, y: 0, z: (FLOOR + Math.max(top, CEILING)) / 2 }, terms);
  return { width, height, scale, offsetX: middle.x, offsetY: middle.y, centerX: usable * 0.5, centerY: height * 0.5, ...terms };
}

export function projectSurface3D(point: { x: number; y: number; z: number }, viewport: Surface3DViewport) {
  const raw = rawProject(point, viewport);
  return { x: viewport.centerX + (raw.x - viewport.offsetX) * viewport.scale,
    y: viewport.centerY + (raw.y - viewport.offsetY) * viewport.scale, depth: raw.depth };
}

/** Walls on the far sides, tick labels on the near edges, z labels on the leftmost corner. */
export interface Surface3DLayout { farX: number; farY: number; nearX: number; nearY: number; zCorner: { x: number; y: number } }
export function surface3DLayout(viewport: Surface3DViewport): Surface3DLayout {
  const farX = viewport.sinA > 0 ? -X_EXTENT : X_EXTENT, farY = viewport.cosA > 0 ? -Y_EXTENT : Y_EXTENT;
  const zCorner = [-X_EXTENT, X_EXTENT].flatMap((x) => [-Y_EXTENT, Y_EXTENT].map((y) => ({ x, y })))
    .sort((a, b) => projectSurface3D({ ...a, z: FLOOR }, viewport).x - projectSurface3D({ ...b, z: FLOOR }, viewport).x)[0]!;
  return { farX, farY, nearX: -farX, nearY: -farY, zCorner };
}

export interface Surface3DScene {
  input: Surface3DInput;
  /** Display lattice: subdivided rows x columns, xyz per point (NaN when missing). */
  latticeRows: number;
  latticeColumns: number;
  subdivisions: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Triangles over the lattice, then boundary fans over appended node vertices. */
  indices: Uint32Array;
  vertexCount: number;
  /** Line segments (pairs of xyz) along the grid nodes' rows and columns, following the smooth surface. */
  wire: Float32Array;
  ridge: Float32Array;
  nodes: { row: number; column: number; x: number; y: number; z: number; value: number }[];
  /** Highest world z, for fitting spikes above the box. */
  top: number;
  worldZ: (value: number) => number;
  colorOf: (value: number) => Surface3DColor;
}

/** Catmull-Rom through p1..p2, bounded by its inputs so spikes do not ring. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  const value = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  return clamp(value, Math.min(p0, p1, p2, p3), Math.max(p0, p1, p2, p3));
}

/**
 * Faces joining adjacent rows inside their contiguous support. Complete cells
 * are quads; at the outer boundary a triangle fan joins the wider row to the
 * narrower row's endpoint, using only existing nodes. Internal gaps stay open.
 */
export function surfaceBoundaryFans(available: readonly (readonly boolean[])[]): Surface3DCell[][] {
  const faces: Surface3DCell[][] = [];
  const contiguous = (row: readonly boolean[]) => {
    const first = row.indexOf(true), last = row.lastIndexOf(true);
    return first < 0 || row.slice(first, last + 1).some((value) => !value) ? null : { first, last };
  };
  for (let row = 0; row < available.length - 1; row += 1) {
    const a = contiguous(available[row]!), b = contiguous(available[row + 1]!);
    if (!a || !b || Math.max(a.first, b.first) >= Math.min(a.last, b.last)) continue;
    const fan = (tipRow: number, tipColumn: number, edgeRow: number, from: number, to: number) => {
      for (let column = from; column < to; column += 1) faces.push([{ row: tipRow, column: tipColumn }, { row: edgeRow, column }, { row: edgeRow, column: column + 1 }]);
    };
    if (a.first > b.first) fan(row, a.first, row + 1, b.first, a.first);
    else if (b.first > a.first) fan(row + 1, b.first, row, a.first, b.first);
    if (a.last < b.last) fan(row, a.last, row + 1, a.last, b.last);
    else if (b.last < a.last) fan(row + 1, b.last, row, b.last, a.last);
  }
  return faces;
}

export function buildSurface3DScene(input: Surface3DInput, subdivisions = 5): Surface3DScene {
  const rowCount = input.values.length, columnCount = input.columnPositions.length;
  const span = Math.max(input.zMax - input.zMin, 1e-9);
  const worldZ = (value: number) => FLOOR + clamp((value - input.zMin) / span, -0.08, 1.25) * (CEILING - FLOOR);
  const colorOf = (value: number) => turbo((value - input.zMin) / span);
  const node = (r: number, c: number) => {
    const value = input.values[r]?.[c];
    return value != null && Number.isFinite(value) ? value : null;
  };
  const worldX = (cf: number) => {
    const low = clamp(Math.floor(cf), 0, Math.max(0, columnCount - 1)), high = Math.min(columnCount - 1, low + 1);
    const position = input.columnPositions[low]! + (input.columnPositions[high]! - input.columnPositions[low]!) * (cf - low);
    return (position * 2 - 1) * X_EXTENT;
  };
  const worldY = (rf: number) => {
    const low = clamp(Math.floor(rf), 0, Math.max(0, rowCount - 1)), high = Math.min(rowCount - 1, low + 1);
    const position = input.rowPositions[low]! + (input.rowPositions[high]! - input.rowPositions[low]!) * (rf - low);
    return (1 - position * 2) * Y_EXTENT;
  };
  const complete = (r: number, c: number) => r >= 0 && c >= 0 && r < rowCount - 1 && c < columnCount - 1
    && node(r, c) != null && node(r, c + 1) != null && node(r + 1, c) != null && node(r + 1, c + 1) != null;
  const along = (r: number, c: number, v: number): number | null => {
    const p1 = node(r, c), p2 = node(r, c + 1);
    if (p1 == null || p2 == null) return null;
    return catmullRom(node(r, c - 1) ?? 2 * p1 - p2, p1, p2, node(r, c + 2) ?? 2 * p2 - p1, v);
  };
  /** Points on shared edges belong to any complete neighbouring cell; the spline agrees on edges. */
  const evaluate = (rf: number, cf: number): number | null => {
    const rows = Number.isInteger(rf) ? [rf, rf - 1] : [Math.floor(rf)];
    const columns = Number.isInteger(cf) ? [cf, cf - 1] : [Math.floor(cf)];
    for (const r of rows) for (const c of columns) {
      if (!complete(r, c)) continue;
      const u = clamp(rf - r, 0, 1), v = clamp(cf - c, 0, 1);
      const q1 = along(r, c, v)!, q2 = along(r + 1, c, v)!;
      return catmullRom(along(r - 1, c, v) ?? 2 * q1 - q2, q1, q2, along(r + 2, c, v) ?? 2 * q2 - q1, u);
    }
    return null;
  };

  const s = Math.max(1, Math.round(subdivisions));
  const latticeRows = rowCount >= 2 ? (rowCount - 1) * s + 1 : 0;
  const latticeColumns = columnCount >= 2 ? (columnCount - 1) * s + 1 : 0;
  const latticeCount = latticeRows * latticeColumns;
  const nodeCount = rowCount * columnCount;
  const vertexCount = latticeCount + nodeCount;
  const positions = new Float32Array(vertexCount * 3).fill(Number.NaN);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const values = new Float64Array(latticeCount).fill(Number.NaN);
  for (let i = 0; i < latticeRows; i += 1) for (let j = 0; j < latticeColumns; j += 1) {
    const value = evaluate(i / s, j / s);
    if (value == null) continue;
    const index = i * latticeColumns + j;
    values[index] = value;
    positions.set([worldX(j / s), worldY(i / s), worldZ(value)], index * 3);
    const color = colorOf(value);
    colors.set([color.r, color.g, color.b], index * 3);
  }
  const at = (i: number, j: number, fallback: number) => {
    const index = i >= 0 && j >= 0 && i < latticeRows && j < latticeColumns ? i * latticeColumns + j : -1;
    return index >= 0 && Number.isFinite(values[index]) ? index : fallback;
  };
  for (let i = 0; i < latticeRows; i += 1) for (let j = 0; j < latticeColumns; j += 1) {
    const index = i * latticeColumns + j;
    if (!Number.isFinite(values[index])) continue;
    const e = at(i, j + 1, index), w = at(i, j - 1, index), n = at(i + 1, j, index), so = at(i - 1, j, index);
    const du = [positions[e * 3]! - positions[w * 3]!, positions[e * 3 + 1]! - positions[w * 3 + 1]!, positions[e * 3 + 2]! - positions[w * 3 + 2]!];
    const dv = [positions[n * 3]! - positions[so * 3]!, positions[n * 3 + 1]! - positions[so * 3 + 1]!, positions[n * 3 + 2]! - positions[so * 3 + 2]!];
    const normal = [du[1]! * dv[2]! - du[2]! * dv[1]!, du[2]! * dv[0]! - du[0]! * dv[2]!, du[0]! * dv[1]! - du[1]! * dv[0]!];
    const length = Math.hypot(normal[0]!, normal[1]!, normal[2]!) || 1;
    normals.set([normal[0]! / length, normal[1]! / length, normal[2]! / length], index * 3);
  }
  const nodes: Surface3DScene["nodes"] = [];
  for (let r = 0; r < rowCount; r += 1) for (let c = 0; c < columnCount; c += 1) {
    const value = node(r, c);
    if (value == null) continue;
    const index = latticeCount + r * columnCount + c;
    const point = { x: worldX(c), y: worldY(r), z: worldZ(value) };
    positions.set([point.x, point.y, point.z], index * 3);
    normals.set([0, 0, 1], index * 3);
    const color = colorOf(value);
    colors.set([color.r * 0.9, color.g * 0.9, color.b * 0.9], index * 3);
    nodes.push({ row: r, column: c, ...point, value });
  }

  const indices: number[] = [];
  for (let i = 0; i < latticeRows - 1; i += 1) for (let j = 0; j < latticeColumns - 1; j += 1) {
    const a = i * latticeColumns + j, b = a + 1, d = a + latticeColumns, c = d + 1;
    const ok = (index: number) => Number.isFinite(values[index]);
    if (ok(a) && ok(b) && ok(c)) indices.push(a, b, c);
    if (ok(a) && ok(c) && ok(d)) indices.push(a, c, d);
  }
  const available = Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => node(r, c) != null));
  for (const face of surfaceBoundaryFans(available)) indices.push(...face.map(({ row, column }) => latticeCount + row * columnCount + column));

  // Wire along node rows and a readable subset of node columns.
  const wire: number[] = [];
  const columnStep = Math.max(1, Math.round(columnCount / 24));
  const push = (from: number, to: number) => wire.push(...positions.subarray(from * 3, from * 3 + 3), ...positions.subarray(to * 3, to * 3 + 3));
  for (let i = 0; i < latticeRows; i += 1) for (let j = 0; j < latticeColumns; j += 1) {
    const index = i * latticeColumns + j;
    if (!Number.isFinite(values[index])) continue;
    if (i % s === 0 && j + 1 < latticeColumns && Number.isFinite(values[index + 1])) push(index, index + 1);
    if (j % s === 0 && (j / s) % columnStep === 0 && i + 1 < latticeRows && Number.isFinite(values[index + latticeColumns])) push(index, index + latticeColumns);
  }
  // Fans get an outline only on the support boundary, not on every internal spoke.
  const fanEdges = new Map<string, number[]>();
  for (const face of surfaceBoundaryFans(available)) {
    const ids = face.map(({ row, column }) => latticeCount + row * columnCount + column);
    for (let k = 0; k < 3; k += 1) {
      const a = ids[k]!, b = ids[(k + 1) % 3]!, key = a < b ? `${a}:${b}` : `${b}:${a}`;
      fanEdges.set(key, fanEdges.has(key) ? [] : [a, b]);
    }
  }
  for (const edge of fanEdges.values()) if (edge.length === 2) push(edge[0]!, edge[1]!);
  // Rows without any face (neighbours loading or failed) stay visible as their own polylines.
  const faced = new Set<number>();
  for (let r = 0; r < rowCount; r += 1) for (let c = 0; c < columnCount; c += 1) if (complete(r, c)) { faced.add(r); faced.add(r + 1); }
  for (const face of surfaceBoundaryFans(available)) for (const cell of face) faced.add(cell.row);
  for (let r = 0; r < rowCount; r += 1) {
    if (faced.has(r)) continue;
    for (let c = 0; c + 1 < columnCount; c += 1) {
      if (node(r, c) != null && node(r, c + 1) != null) push(latticeCount + r * columnCount + c, latticeCount + r * columnCount + c + 1);
    }
  }

  const ridge: number[] = [];
  const ridgeColumn = input.ridgeColumn;
  if (ridgeColumn != null && ridgeColumn >= 0 && rowCount >= 2) {
    let previous: number[] | null = null;
    for (let i = 0; i < latticeRows; i += 1) {
      const value = evaluate(i / s, ridgeColumn);
      const point = value == null ? null : [worldX(ridgeColumn), worldY(i / s), worldZ(value)];
      if (point && previous) ridge.push(...previous, ...point);
      previous = point;
    }
  }
  const top = Math.max(CEILING, ...nodes.map((point) => point.z));
  return { input, latticeRows, latticeColumns, subdivisions: s, positions, normals, colors,
    indices: new Uint32Array(indices), vertexCount, wire: new Float32Array(wire), ridge: new Float32Array(ridge),
    nodes, top, worldZ, colorOf };
}

/** Light from the viewer's upper left, in world space so it turns with the camera. */
export function surface3DLighting(viewport: Surface3DViewport) {
  const view = { x: viewport.sinA * viewport.cosE, y: viewport.cosA * viewport.cosE, z: viewport.sinE };
  const up = { x: -viewport.sinA * viewport.sinE, y: -viewport.cosA * viewport.sinE, z: viewport.cosE };
  const right = { x: viewport.cosA, y: -viewport.sinA, z: 0 };
  const normalize = (v: { x: number; y: number; z: number }) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const light = normalize({ x: view.x * 0.85 + up.x * 0.9 - right.x * 0.45, y: view.y * 0.85 + up.y * 0.9 - right.y * 0.45, z: view.z * 0.85 + up.z * 0.9 - right.z * 0.45 });
  const halfway = normalize({ x: light.x + view.x, y: light.y + view.y, z: light.z + view.z });
  return { view, light, halfway };
}
export const SURFACE3D_AMBIENT = 0.42, SURFACE3D_DIFFUSE = 0.64, SURFACE3D_SPECULAR = 0.3, SURFACE3D_SHININESS = 36;

/** Box: floor and the two far walls, with grid lines at the tick positions. */
export interface Surface3DBox {
  panels: { x: number; y: number; z: number }[][];
  grid: number[];
  edges: number[];
}
export function surface3DBox(scene: Surface3DScene, layout: Surface3DLayout): Surface3DBox {
  const { farX, farY } = layout;
  const x = (position: number) => (position * 2 - 1) * X_EXTENT;
  const y = (position: number) => (1 - position * 2) * Y_EXTENT;
  const panels = [
    [{ x: -X_EXTENT, y: -Y_EXTENT, z: FLOOR }, { x: X_EXTENT, y: -Y_EXTENT, z: FLOOR }, { x: X_EXTENT, y: Y_EXTENT, z: FLOOR }, { x: -X_EXTENT, y: Y_EXTENT, z: FLOOR }],
    [{ x: farX, y: -Y_EXTENT, z: FLOOR }, { x: farX, y: Y_EXTENT, z: FLOOR }, { x: farX, y: Y_EXTENT, z: CEILING }, { x: farX, y: -Y_EXTENT, z: CEILING }],
    [{ x: -X_EXTENT, y: farY, z: FLOOR }, { x: X_EXTENT, y: farY, z: FLOOR }, { x: X_EXTENT, y: farY, z: CEILING }, { x: -X_EXTENT, y: farY, z: CEILING }],
  ];
  const grid: number[] = [];
  const segment = (a: number[], b: number[]) => grid.push(...a, ...b);
  for (const tick of scene.input.xTicks) {
    segment([x(tick.position), -Y_EXTENT, FLOOR], [x(tick.position), Y_EXTENT, FLOOR]);
    segment([x(tick.position), farY, FLOOR], [x(tick.position), farY, CEILING]);
  }
  for (const tick of scene.input.yTicks) {
    segment([-X_EXTENT, y(tick.position), FLOOR], [X_EXTENT, y(tick.position), FLOOR]);
    segment([farX, y(tick.position), FLOOR], [farX, y(tick.position), CEILING]);
  }
  for (const tick of scene.input.zTicks) {
    const z = scene.worldZ(tick.value);
    segment([farX, -Y_EXTENT, z], [farX, Y_EXTENT, z]);
    segment([-X_EXTENT, farY, z], [X_EXTENT, farY, z]);
  }
  const edges: number[] = [];
  const edge = (a: number[], b: number[]) => edges.push(...a, ...b);
  edge([-X_EXTENT, -Y_EXTENT, FLOOR], [X_EXTENT, -Y_EXTENT, FLOOR]);
  edge([X_EXTENT, -Y_EXTENT, FLOOR], [X_EXTENT, Y_EXTENT, FLOOR]);
  edge([X_EXTENT, Y_EXTENT, FLOOR], [-X_EXTENT, Y_EXTENT, FLOOR]);
  edge([-X_EXTENT, Y_EXTENT, FLOOR], [-X_EXTENT, -Y_EXTENT, FLOOR]);
  edge([farX, farY, FLOOR], [farX, farY, CEILING]);
  edge([farX, -farY, FLOOR], [farX, -farY, CEILING]);
  edge([-farX, farY, FLOOR], [-farX, farY, CEILING]);
  edge([farX, -Y_EXTENT, CEILING], [farX, Y_EXTENT, CEILING]);
  edge([-X_EXTENT, farY, CEILING], [X_EXTENT, farY, CEILING]);
  return { panels, grid, edges };
}

/** A label anchored in world space; `dx`/`dy` are screen offsets in label-height units. */
export interface Surface3DLabel {
  key: string;
  text: string;
  world: { x: number; y: number; z: number };
  align: "left" | "center" | "right";
  dx: number;
  dy: number;
  role: "tick" | "title" | "value";
}
export function surface3DLabels(scene: Surface3DScene, viewport: Surface3DViewport, layout: Surface3DLayout): Surface3DLabel[] {
  const { input } = scene;
  const labels: Surface3DLabel[] = [];
  const x = (position: number) => (position * 2 - 1) * X_EXTENT;
  const y = (position: number) => (1 - position * 2) * Y_EXTENT;
  const zc = layout.zCorner;
  // The floor level is the colour bar's lowest tick; labelling it on the corner collides with the tenor axis.
  for (const tick of input.zTicks) {
    if (scene.worldZ(tick.value) <= FLOOR + 1e-6) continue;
    labels.push({ key: `z:${tick.label}`, text: tick.label, world: { ...zc, z: scene.worldZ(tick.value) }, align: "right", dx: -0.8, dy: 0, role: "tick" });
  }
  labels.push({ key: "z:title", text: input.titles.z, world: { ...zc, z: CEILING }, align: "center", dx: 0, dy: -2, role: "title" });
  for (const tick of input.xTicks) labels.push({ key: `x:${tick.label}`, text: tick.label, world: { x: x(tick.position), y: layout.nearY * 1.07, z: FLOOR }, align: "center", dx: 0, dy: 1.2, role: "tick" });
  labels.push({ key: "x:title", text: input.titles.x, world: { x: 0, y: layout.nearY * 1.07, z: FLOOR }, align: "center", dx: 0, dy: 3.2, role: "title" });
  const leftward = projectSurface3D({ x: layout.nearX, y: 0, z: FLOOR }, viewport).x < projectSurface3D({ x: 0, y: 0, z: FLOOR }, viewport).x;
  const align = leftward ? "right" as const : "left" as const;
  for (const tick of input.yTicks) labels.push({ key: `y:${tick.label}`, text: tick.label, world: { x: layout.nearX * 1.05, y: y(tick.position), z: FLOOR }, align, dx: leftward ? -0.5 : 0.5, dy: 0.5, role: "tick" });
  labels.push({ key: "y:title", text: input.titles.y, world: { x: layout.nearX * 1.05, y: 0, z: FLOOR }, align, dx: leftward ? -4.5 : 4.5, dy: 2.6, role: "title" });
  if (scene.ridge.length >= 3 && input.ridgeLabel) {
    const end = scene.ridge.length - 3;
    labels.push({ key: "ridge", text: input.ridgeLabel, world: { x: scene.ridge[end]!, y: scene.ridge[end + 1]!, z: scene.ridge[end + 2]! }, align: "left", dx: 0.9, dy: -1.3, role: "value" });
  }
  const chosen = input.selected ? scene.nodes.find((point) => point.row === input.selected!.row && point.column === input.selected!.column) : null;
  if (chosen) labels.push({ key: "selected", text: input.formatValue?.(chosen.value) ?? chosen.value.toFixed(2), world: chosen, align: "left", dx: 1.4, dy: -1.6, role: "value" });
  return labels;
}

/** Nearest projected grid node; camera depth breaks ties between overlapping nodes. */
export function hitTestSurface3D(scene: Surface3DScene, viewport: Surface3DViewport, x: number, y: number, radius = 18): Surface3DCell | null {
  let best: { row: number; column: number; depth: number } | null = null;
  let distance = radius;
  for (const point of scene.nodes) {
    const projected = projectSurface3D(point, viewport);
    const next = Math.hypot(projected.x - x, projected.y - y);
    if (next > radius) continue;
    if (next < distance - 0.5 || (Math.abs(next - distance) <= 0.5 && (!best || projected.depth > best.depth))) {
      best = { row: point.row, column: point.column, depth: projected.depth };
      distance = next;
    }
  }
  return best ? { row: best.row, column: best.column } : null;
}
