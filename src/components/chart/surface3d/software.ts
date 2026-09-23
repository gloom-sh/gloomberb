import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { blendPixel, clamp, drawCircle, drawLine, fillOpaque, parseHex, type RgbaColor } from "../native/raster/primitives";
import { blendHex } from "../../../theme/color-utils";
import {
  FLOOR, FLOOR_PROJECTION_ALPHA, projectSurface3D, surface3DBox, surface3DLabels, surface3DLayout, surface3DLighting, surface3DViewport, turbo,
  SURFACE3D_AMBIENT, SURFACE3D_DIFFUSE, SURFACE3D_SHININESS, SURFACE3D_SPECULAR,
  type Surface3DCamera, type Surface3DLabel, type Surface3DScene, type Surface3DViewport,
} from "./model";

export interface Surface3DColors { bg: string; grid: string; axis: string; accent: string; ridge: string }
/** A label placed at output pixels: top-left box for bitmap text plus its anchor. */
export interface PlacedSurface3DLabel extends Surface3DLabel { x: number; y: number; anchorX: number; anchorY: number; color: string }
export interface Surface3DRender {
  bitmap: NativeChartBitmap;
  viewport: Surface3DViewport;
  labels: PlacedSurface3DLabel[];
  fontScale: number;
}
export interface Surface3DSoftwareOptions {
  /** Draft skips supersampling while the camera moves. */
  quality?: "high" | "draft";
  paintText?: boolean;
  /** Fraction of the width kept for the colour bar. */
  reserveRight?: number;
}

const GLYPHS: Record<string, string> = {
  "0": "01110/10001/10011/10101/11001/10001/01110", "1": "00100/01100/00100/00100/00100/00100/01110",
  "2": "01110/10001/00001/00010/00100/01000/11111", "3": "11110/00001/00001/01110/00001/00001/11110",
  "4": "00010/00110/01010/10010/11111/00010/00010", "5": "11111/10000/10000/11110/00001/00001/11110",
  "6": "01110/10000/10000/11110/10001/10001/01110", "7": "11111/00001/00010/00100/01000/01000/01000",
  "8": "01110/10001/10001/01110/10001/10001/01110", "9": "01110/10001/10001/01111/00001/00001/01110",
  A: "01110/10001/10001/11111/10001/10001/10001", B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01111/10000/10000/10000/10000/10000/01111", D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111", F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01111/10000/10000/10111/10001/10001/01111", H: "10001/10001/10001/11111/10001/10001/10001",
  I: "01110/00100/00100/00100/00100/00100/01110", J: "00111/00010/00010/00010/00010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001", L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001", N: "10001/11001/11001/10101/10011/10011/10001",
  O: "01110/10001/10001/10001/10001/10001/01110", P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101", R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110", T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110", V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/10101/01010", X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100", Z: "11111/00001/00010/00100/01000/10000/11111",
  "%": "11001/11001/00010/00100/01000/10011/10011", ".": "00000/00000/00000/00000/00000/00110/00110",
  "/": "00001/00001/00010/00100/01000/10000/10000", "-": "00000/00000/00000/11111/00000/00000/00000",
  "+": "00000/00100/00100/11111/00100/00100/00000", " ": "00000/00000/00000/00000/00000/00000/00000",
};
const GLYPH_ROWS = Object.fromEntries(Object.entries(GLYPHS).map(([key, glyph]) => [key, glyph.split("/")]));
export const surface3DLabelWidth = (text: string, scale: number) => Math.max(0, text.length * 6 - 1) * scale;

function paintLabel(bitmap: NativeChartBitmap, text: string, x: number, y: number, color: RgbaColor, scale: number) {
  const left = Math.round(x), top = Math.round(y);
  for (let index = 0; index < text.length; index += 1) {
    const glyph = GLYPH_ROWS[text[index]!.toUpperCase()];
    if (!glyph) continue;
    for (let row = 0; row < 7; row += 1) for (let column = 0; column < 5; column += 1) {
      if (glyph[row]![column] !== "1") continue;
      for (let sy = 0; sy < scale; sy += 1) for (let sx = 0; sx < scale; sx += 1) {
        blendPixel(bitmap.pixels, bitmap.width, bitmap.height, left + (index * 6 + column) * scale + sx, top + row * scale + sy, color);
      }
    }
  }
}

interface Raster { width: number; height: number; pixels: Uint8Array; depth: Float32Array }
interface Vertex { x: number; y: number; depth: number; r: number; g: number; b: number }

/** Edge-function rasterizer: incremental barycentrics, one add per pixel per term. */
function fillTriangle(raster: Raster, a: Vertex, b: Vertex, c: Vertex, alpha = 1, testDepth = true) {
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-9) return;
  const left = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const right = Math.min(raster.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const top = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const bottom = Math.min(raster.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  if (left > right || top > bottom) return;
  const inv = 1 / area;
  // Weights of a, b, c as affine functions of (x, y): w = w0 + wx * x + wy * y.
  const ax = (b.y - c.y) * inv, ay = (c.x - b.x) * inv, a0 = (b.x * c.y - c.x * b.y) * inv;
  const bx = (c.y - a.y) * inv, by = (a.x - c.x) * inv, b0 = (c.x * a.y - a.x * c.y) * inv;
  const attribute = (va: number, vb: number, vc: number) => {
    const cx = -ax - bx, cy = -ay - by, c0 = 1 - a0 - b0;
    return { dx: ax * va + bx * vb + cx * vc, dy: ay * va + by * vb + cy * vc, o: a0 * va + b0 * vb + c0 * vc };
  };
  const d = attribute(a.depth, b.depth, c.depth), r = attribute(a.r, b.r, c.r), g = attribute(a.g, b.g, c.g), bl = attribute(a.b, b.b, c.b);
  const pixels = raster.pixels, depth = raster.depth, width = raster.width;
  const epsilon = -1e-7;
  for (let y = top; y <= bottom; y += 1) {
    const sy = y + 0.5;
    let wa = a0 + ax * (left + 0.5) + ay * sy, wb = b0 + bx * (left + 0.5) + by * sy;
    let z = d.o + d.dx * (left + 0.5) + d.dy * sy;
    let cr = r.o + r.dx * (left + 0.5) + r.dy * sy, cg = g.o + g.dx * (left + 0.5) + g.dy * sy, cb = bl.o + bl.dx * (left + 0.5) + bl.dy * sy;
    for (let x = left; x <= right; x += 1, wa += ax, wb += bx, z += d.dx, cr += r.dx, cg += g.dx, cb += bl.dx) {
      if (wa < epsilon || wb < epsilon || 1 - wa - wb < epsilon) continue;
      const index = y * width + x;
      if (testDepth) {
        if (z <= depth[index]!) continue;
        depth[index] = z;
      }
      const offset = index * 4;
      const red = cr < 0 ? 0 : cr > 255 ? 255 : cr, green = cg < 0 ? 0 : cg > 255 ? 255 : cg, blue = cb < 0 ? 0 : cb > 255 ? 255 : cb;
      if (alpha >= 1) {
        pixels[offset] = red; pixels[offset + 1] = green; pixels[offset + 2] = blue; pixels[offset + 3] = 255;
      } else {
        const pr = pixels[offset]!, pg = pixels[offset + 1]!, pb = pixels[offset + 2]!;
        pixels[offset] = pr + (red - pr) * alpha; pixels[offset + 1] = pg + (green - pg) * alpha; pixels[offset + 2] = pb + (blue - pb) * alpha;
      }
    }
  }
}

/**
 * Visits the pixels of an anti-aliased segment by walking its major axis, so
 * the cost follows length x thickness rather than the segment's bounding box.
 */
function linePixels(raster: { width: number; height: number }, a: { x: number; y: number }, b: { x: number; y: number }, half: number,
  visit: (px: number, py: number, t: number, coverage: number) => void) {
  const dx = b.x - a.x, dy = b.y - a.y, lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return;
  const reach = half + 1.6;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const from = Math.floor(Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y) - reach);
  const to = Math.ceil(Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y) + reach);
  const limit = horizontal ? raster.width - 1 : raster.height - 1, cross = horizontal ? raster.height - 1 : raster.width - 1;
  for (let major = Math.max(0, from); major <= Math.min(limit, to); major += 1) {
    const t0 = clamp(((major + 0.5) - (horizontal ? a.x : a.y)) / (horizontal ? dx || 1e-9 : dy || 1e-9), 0, 1);
    const center = (horizontal ? a.y + dy * t0 : a.x + dx * t0);
    const slope = horizontal ? Math.abs(dy / (dx || 1e-9)) : Math.abs(dx / (dy || 1e-9));
    const spread = reach * Math.sqrt(1 + slope * slope);
    for (let minor = Math.max(0, Math.floor(center - spread)); minor <= Math.min(cross, Math.ceil(center + spread)); minor += 1) {
      const px = horizontal ? major : minor, py = horizontal ? minor : major;
      const t = clamp(((px + 0.5 - a.x) * dx + (py + 0.5 - a.y) * dy) / lengthSq, 0, 1);
      const coverage = 1 - clamp((Math.hypot(px + 0.5 - (a.x + dx * t), py + 0.5 - (a.y + dy * t)) - half) / 1.1, 0, 1);
      if (coverage > 0) visit(px, py, t, coverage);
    }
  }
}

function flatLine(raster: Raster, a: { x: number; y: number }, b: { x: number; y: number }, color: RgbaColor, thickness: number) {
  linePixels(raster, a, b, thickness / 2, (px, py, _t, coverage) => blendPixel(raster.pixels, raster.width, raster.height, px, py, color, coverage));
}

/** Anti-aliased segment that hides behind nearer surface pixels. */
function depthLine(raster: Raster, a: { x: number; y: number; depth: number }, b: { x: number; y: number; depth: number }, color: RgbaColor, thickness: number, bias: number) {
  linePixels(raster, a, b, thickness / 2, (px, py, t, coverage) => {
    if (a.depth + (b.depth - a.depth) * t + bias < raster.depth[py * raster.width + px]!) return;
    blendPixel(raster.pixels, raster.width, raster.height, px, py, color, coverage);
  });
}

// One scratch raster per size, reused across frames while the camera moves.
const rasterPool = new Map<string, Raster>();
function pooledRaster(width: number, height: number): Raster {
  const key = `${width}x${height}`;
  let raster = rasterPool.get(key);
  if (!raster) {
    if (rasterPool.size >= 4) rasterPool.delete(rasterPool.keys().next().value!);
    raster = { width, height, pixels: new Uint8Array(width * height * 4), depth: new Float32Array(width * height) };
    rasterPool.set(key, raster);
  }
  return raster;
}

/** Bilinear upscale of a draft frame to the output size. */
function upscale(source: Raster, width: number, height: number, target: Uint8Array) {
  const sx = source.width / width, sy = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.min(source.height - 1, Math.floor(fy)), y1 = Math.min(source.height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.min(source.width - 1, Math.floor(fx)), x1 = Math.min(source.width - 1, x0 + 1), wx = fx - x0;
      const p00 = (y0 * source.width + x0) * 4, p10 = (y0 * source.width + x1) * 4, p01 = (y1 * source.width + x0) * 4, p11 = (y1 * source.width + x1) * 4;
      const offset = (y * width + x) * 4;
      for (let k = 0; k < 3; k += 1) {
        const top = source.pixels[p00 + k]! + (source.pixels[p10 + k]! - source.pixels[p00 + k]!) * wx;
        const bottom = source.pixels[p01 + k]! + (source.pixels[p11 + k]! - source.pixels[p01 + k]!) * wx;
        target[offset + k] = top + (bottom - top) * wy;
      }
      target[offset + 3] = 255;
    }
  }
}

function downsample(source: Raster, factor: number, width: number, height: number, target: Uint8Array) {
  factor = Math.round(factor);
  const weight = 1 / (factor * factor);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < factor; sy += 1) {
      const row = ((y * factor + sy) * source.width + x * factor) * 4;
      for (let sx = 0; sx < factor; sx += 1) { r += source.pixels[row + sx * 4]!; g += source.pixels[row + sx * 4 + 1]!; b += source.pixels[row + sx * 4 + 2]!; }
    }
    const offset = (y * width + x) * 4;
    target[offset] = r * weight; target[offset + 1] = g * weight; target[offset + 2] = b * weight; target[offset + 3] = 255;
  }
}

/** Places labels at output pixels (bitmap text box and DOM anchor) for a viewport. */
export function placeSurface3DLabels(scene: Surface3DScene, viewport: Surface3DViewport, fontScale: number, colors: Surface3DColors): PlacedSurface3DLabel[] {
  const layout = surface3DLayout(viewport);
  const unit = 9 * fontScale;
  return surface3DLabels(scene, viewport, layout).map((label) => {
    const point = projectSurface3D(label.world, viewport);
    const anchorX = clamp(point.x + label.dx * unit, 4, viewport.width - 4), anchorY = clamp(point.y + label.dy * unit, 4, viewport.height - 4);
    const width = surface3DLabelWidth(label.text, fontScale);
    const left = label.align === "left" ? anchorX : label.align === "right" ? anchorX - width : anchorX - width / 2;
    return { ...label, anchorX, anchorY, x: clamp(left, 4, Math.max(4, viewport.width - width - 4)),
      y: clamp(anchorY - 3.5 * fontScale, 4, Math.max(4, viewport.height - 7 * fontScale - 4)),
      color: label.role === "title" ? colors.accent : label.key === "ridge" ? colors.ridge : label.role === "value" ? "#ffffff" : colors.axis };
  });
}

/**
 * Terminal renderer: z-buffered, per-vertex Blinn-Phong over the shared scene,
 * box with gridded far walls, translucent floor projection, wire and ridge.
 */
export function renderSurface3DSoftware(
  scene: Surface3DScene,
  requestedWidth: number,
  requestedHeight: number,
  colors: Surface3DColors,
  camera: Surface3DCamera,
  options: Surface3DSoftwareOptions = {},
): Surface3DRender {
  const width = clamp(Math.round(Number.isFinite(requestedWidth) ? requestedWidth : 1), 1, 4096);
  const height = clamp(Math.round(Number.isFinite(requestedHeight) ? requestedHeight : 1), 1, 4096);
  const background = parseHex(colors.bg);
  const bitmap = { width, height, pixels: new Uint8Array(width * height * 4) };
  const fontScale = Math.max(1, Math.min(3, Math.floor(Math.min(width / 560, height / 300))));
  const reserveRight = options.reserveRight ?? (width >= 360 ? 0.1 : 0);
  const viewport = surface3DViewport(width, height, camera, scene.top, reserveRight);
  fillOpaque(bitmap.pixels, background);
  if (!scene.nodes.length) return { bitmap, viewport, labels: [], fontScale };

  // Still frames supersample; moving frames render at half size and upscale.
  const factor = (options.quality ?? "high") === "draft" ? 0.5 : width * height <= 2_300_000 ? 2 : 1;
  const rasterWidth = Math.max(1, Math.round(width * factor)), rasterHeight = Math.max(1, Math.round(height * factor));
  const view = surface3DViewport(rasterWidth, rasterHeight, camera, scene.top, reserveRight);
  const raster = pooledRaster(rasterWidth, rasterHeight);
  fillOpaque(raster.pixels, background);
  raster.depth.fill(-Infinity);
  const s = factor;
  const layout = surface3DLayout(view);
  const box = surface3DBox(scene, layout);
  const project = (x: number, y: number, z: number) => projectSurface3D({ x, y, z }, view);
  const panel = parseHex(blendHex(colors.bg, colors.grid, 0.32));
  for (const quad of box.panels) {
    const [a, b, c, d] = quad.map((point): Vertex => ({ ...projectSurface3D(point, view), r: panel.r, g: panel.g, b: panel.b }));
    fillTriangle(raster, a!, b!, c!, 1, false);
    fillTriangle(raster, a!, c!, d!, 1, false);
  }
  const gridLine = parseHex(blendHex(colors.bg, colors.axis, 0.3), 0.9), edge = parseHex(blendHex(colors.bg, colors.axis, 0.55));
  const segments = (values: ArrayLike<number>, color: RgbaColor, thickness: number) => {
    for (let index = 0; index + 5 < values.length; index += 6) {
      const a = project(values[index]!, values[index + 1]!, values[index + 2]!), b = project(values[index + 3]!, values[index + 4]!, values[index + 5]!);
      flatLine(raster, a, b, color, thickness);
    }
  };
  segments(box.grid, gridLine, s);
  segments(box.edges, edge, 1.2 * s);

  const { view: eye, light, halfway } = surface3DLighting(view);
  const projected: (Vertex | null)[] = new Array(scene.vertexCount);
  const floor: (Vertex | null)[] = new Array(scene.vertexCount);
  for (let index = 0; index < scene.vertexCount; index += 1) {
    const x = scene.positions[index * 3]!, y = scene.positions[index * 3 + 1]!, z = scene.positions[index * 3 + 2]!;
    if (!Number.isFinite(x)) { projected[index] = null; floor[index] = null; continue; }
    let nx = scene.normals[index * 3]!, ny = scene.normals[index * 3 + 1]!, nz = scene.normals[index * 3 + 2]!;
    if (nx * eye.x + ny * eye.y + nz * eye.z < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const diffuse = Math.max(0, nx * light.x + ny * light.y + nz * light.z);
    const specular = Math.max(0, nx * halfway.x + ny * halfway.y + nz * halfway.z) ** SURFACE3D_SHININESS * SURFACE3D_SPECULAR * 255;
    const shade = (SURFACE3D_AMBIENT + SURFACE3D_DIFFUSE * diffuse) * 255;
    const cr = scene.colors[index * 3]!, cg = scene.colors[index * 3 + 1]!, cb = scene.colors[index * 3 + 2]!;
    projected[index] = { ...project(x, y, z), r: cr * shade + specular, g: cg * shade + specular, b: cb * shade + specular };
    floor[index] = { ...project(x, y, FLOOR), r: cr * 255, g: cg * 255, b: cb * 255 };
  }
  const indices = scene.indices;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = floor[indices[index]!], b = floor[indices[index + 1]!], c = floor[indices[index + 2]!];
    if (a && b && c) fillTriangle(raster, a, b, c, FLOOR_PROJECTION_ALPHA, false);
  }
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = projected[indices[index]!], b = projected[indices[index + 1]!], c = projected[indices[index + 2]!];
    if (a && b && c) fillTriangle(raster, a, b, c);
  }
  const bias = 0.012;
  const wire = { r: 8, g: 10, b: 18, a: 105 };
  for (let index = 0; index + 5 < scene.wire.length; index += 6) {
    const a = project(scene.wire[index]!, scene.wire[index + 1]!, scene.wire[index + 2]!);
    const b = project(scene.wire[index + 3]!, scene.wire[index + 4]!, scene.wire[index + 5]!);
    depthLine(raster, a, b, wire, 0.9 * s, bias);
  }
  const ridgeColor = parseHex(colors.ridge);
  for (let index = 0; index + 5 < scene.ridge.length; index += 6) {
    const a = project(scene.ridge[index]!, scene.ridge[index + 1]!, scene.ridge[index + 2]!);
    const b = project(scene.ridge[index + 3]!, scene.ridge[index + 4]!, scene.ridge[index + 5]!);
    depthLine(raster, a, b, { ...ridgeColor, a: 70 }, 5.5 * s * fontScale, bias * 2);
    depthLine(raster, a, b, ridgeColor, 1.6 * s * fontScale, bias * 2);
  }
  const chosen = scene.input.selected ? scene.nodes.find((point) => point.row === scene.input.selected!.row && point.column === scene.input.selected!.column) : null;
  if (chosen) {
    const top = project(chosen.x, chosen.y, chosen.z), base = project(chosen.x, chosen.y, FLOOR);
    const dashes = Math.max(1, Math.floor(Math.hypot(base.x - top.x, base.y - top.y) / (6 * s)));
    for (let index = 0; index < dashes; index += 2) {
      const from = index / dashes, to = Math.min(1, (index + 1) / dashes);
      flatLine(raster, { x: top.x + (base.x - top.x) * from, y: top.y + (base.y - top.y) * from },
        { x: top.x + (base.x - top.x) * to, y: top.y + (base.y - top.y) * to }, { r: 255, g: 255, b: 255, a: 150 }, s);
    }
    drawCircle(raster.pixels, raster.width, raster.height, top.x, top.y, 9 * s * fontScale, { r: 255, g: 255, b: 255, a: 40 });
    drawCircle(raster.pixels, raster.width, raster.height, top.x, top.y, 4.6 * s * fontScale, { r: 255, g: 255, b: 255, a: 255 });
    drawCircle(raster.pixels, raster.width, raster.height, top.x, top.y, 2.4 * s * fontScale, { r: 16, g: 18, b: 28, a: 255 });
  }
  if (factor === 1) bitmap.pixels.set(raster.pixels);
  else if (factor > 1) downsample(raster, factor, width, height, bitmap.pixels);
  else upscale(raster, width, height, bitmap.pixels);

  if (reserveRight > 0) paintColorBar(bitmap, scene, reserveRight, fontScale, colors);
  const labels = placeSurface3DLabels(scene, viewport, fontScale, colors);
  if (reserveRight > 0) labels.push(...colorBarLabels(scene, width, height, reserveRight, fontScale, colors));
  if (options.paintText !== false) {
    for (const label of labels) {
      paintLabel(bitmap, label.text, label.x + 1, label.y + 1, { ...background, a: 210 }, fontScale);
      paintLabel(bitmap, label.text, label.x, label.y, parseHex(label.color), fontScale);
    }
  }
  return { bitmap, viewport, labels, fontScale };
}

export function surface3DColorBarGeometry(width: number, height: number, reserveRight: number, fontScale: number) {
  const barWidth = Math.max(6, 5 * fontScale);
  return { x: Math.round(width - width * reserveRight * 0.62), top: Math.round(height * 0.16), bottom: Math.round(height * 0.74), width: barWidth };
}

function paintColorBar(bitmap: NativeChartBitmap, scene: Surface3DScene, reserveRight: number, fontScale: number, colors: Surface3DColors) {
  const bar = surface3DColorBarGeometry(bitmap.width, bitmap.height, reserveRight, fontScale);
  for (let y = bar.top; y <= bar.bottom; y += 1) {
    const color = turbo((bar.bottom - y) / Math.max(1, bar.bottom - bar.top));
    for (let x = bar.x; x < bar.x + bar.width; x += 1) {
      const offset = (y * bitmap.width + x) * 4;
      bitmap.pixels[offset] = color.r * 255; bitmap.pixels[offset + 1] = color.g * 255; bitmap.pixels[offset + 2] = color.b * 255; bitmap.pixels[offset + 3] = 255;
    }
  }
  for (const tick of scene.input.zTicks) {
    const y = bar.bottom - (tick.value - scene.input.zMin) / Math.max(scene.input.zMax - scene.input.zMin, 1e-9) * (bar.bottom - bar.top);
    drawLine(bitmap.pixels, bitmap.width, bitmap.height, bar.x + bar.width, y, bar.x + bar.width + 3 * fontScale, y, parseHex(colors.axis), 1);
  }
}

export function colorBarLabels(scene: Surface3DScene, width: number, height: number, reserveRight: number, fontScale: number, colors: Surface3DColors): PlacedSurface3DLabel[] {
  const bar = surface3DColorBarGeometry(width, height, reserveRight, fontScale);
  return scene.input.zTicks.map((tick) => {
    const anchorY = bar.bottom - (tick.value - scene.input.zMin) / Math.max(scene.input.zMax - scene.input.zMin, 1e-9) * (bar.bottom - bar.top);
    const anchorX = bar.x + bar.width + 5 * fontScale;
    return { key: `bar:${tick.label}`, text: tick.label, world: { x: 0, y: 0, z: 0 }, align: "left" as const, dx: 0, dy: 0, role: "tick" as const,
      anchorX, anchorY, x: anchorX, y: anchorY - 3.5 * fontScale, color: colors.axis };
  });
}

