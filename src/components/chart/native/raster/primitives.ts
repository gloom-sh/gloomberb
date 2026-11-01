import { parseHex as parseRgbHex } from "../../../../theme/color-utils";
import { clamp } from "../../../../utils/math";

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Prototype: while a recorder is set, drawing into its `target` buffer adds
 * an op to its list instead of touching pixels, for the WebAssembly kernel
 * (kernels/chart-raster) to replay. Drawing into any other buffer is unchanged.
 */
export interface RasterRecorder {
  target: Uint8Array;
  ops: number[];
}

let recorder: RasterRecorder | null = null;

export function setRasterRecorder(next: RasterRecorder | null): void {
  recorder = next;
}

export function rasterRecorderFor(data: Uint8Array): RasterRecorder | null {
  return recorder !== null && recorder.target === data ? recorder : null;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const range = edge1 - edge0;
  if (range === 0) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / range, 0, 1);
  return t * t * (3 - 2 * t);
}

export function parseHex(hex: string, alpha = 1): RgbaColor {
  const [r, g, b] = parseRgbHex(hex);
  return { r, g, b, a: Math.round(clamp(alpha, 0, 1) * 255) };
}

export function blendPixel(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: RgbaColor,
  opacity = 1,
) {
  const recording = rasterRecorderFor(data);
  if (recording) {
    recording.ops.push(5, x, y, color.r, color.g, color.b, color.a, opacity);
    return;
  }
  if (x < 0 || y < 0 || x >= width || y >= height) return;

  const alpha = clamp((color.a / 255) * opacity, 0, 1);
  if (alpha <= 0) return;
  blendAt(data, (y * width + x) * 4, color, alpha);
}

/** Composites `color` at `alpha` (0 to 1) over the pixel at byte `index`, which the caller has bounds-checked. */
export function blendAt(data: Uint8Array, index: number, color: RgbaColor, alpha: number) {
  const dstAlpha = data[index + 3]!;
  if (dstAlpha === 255) {
    // A chart paints its background first, so nearly every pixel is opaque and
    // stays so: the general formula below with the destination's alpha at one.
    const keep = 1 - alpha;
    data[index] = Math.round(color.r * alpha + data[index]! * keep);
    data[index + 1] = Math.round(color.g * alpha + data[index + 1]! * keep);
    data[index + 2] = Math.round(color.b * alpha + data[index + 2]! * keep);
    return;
  }
  const dst = dstAlpha / 255;
  const outAlpha = alpha + dst * (1 - alpha);

  if (outAlpha <= 0) return;

  const dstFactor = dst * (1 - alpha);
  data[index] = Math.round((color.r * alpha + data[index]! * dstFactor) / outAlpha);
  data[index + 1] = Math.round((color.g * alpha + data[index + 1]! * dstFactor) / outAlpha);
  data[index + 2] = Math.round((color.b * alpha + data[index + 2]! * dstFactor) / outAlpha);
  data[index + 3] = Math.round(outAlpha * 255);
}

/** Edge softening of a stroke: coverage falls from full to none over this many pixels past its half width. */
const LINE_FEATHER = 1.1;

export function drawLine(
  data: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RgbaColor,
  thickness: number,
) {
  const recording = rasterRecorderFor(data);
  if (recording) {
    recording.ops.push(3, x0, y0, x1, y1, color.r, color.g, color.b, color.a, thickness);
    return;
  }
  const half = thickness / 2;
  const reach = half + LINE_FEATHER;
  const colorAlpha = clamp(color.a / 255, 0, 1);
  if (colorAlpha <= 0) return;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + half + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + half + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const segmentLengthSq = dx * dx + dy * dy || 1;
  const reachSq = reach * reach;
  // Every pixel the stroke covers lies within `reach` of the line through the
  // segment, so each row only visits that band, not the segment's whole box:
  // a steep line in a tall plot otherwise tests every pixel beside it.
  const bandHalfWidth = dy !== 0 ? (reach * Math.sqrt(segmentLengthSq)) / Math.abs(dy) + 1 : Number.POSITIVE_INFINITY;

  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5;
    let rowMin = minX;
    let rowMax = maxX;
    if (dy !== 0) {
      const centerX = x0 + (dx * (cy - y0)) / dy - 0.5;
      rowMin = Math.max(minX, Math.floor(centerX - bandHalfWidth));
      rowMax = Math.min(maxX, Math.ceil(centerX + bandHalfWidth));
    }
    const rowIndex = py * width;
    for (let px = rowMin; px <= rowMax; px++) {
      const cx = px + 0.5;
      let projection = ((cx - x0) * dx + (cy - y0) * dy) / segmentLengthSq;
      projection = projection < 0 ? 0 : projection > 1 ? 1 : projection;
      const offsetX = cx - (x0 + dx * projection);
      const offsetY = cy - (y0 + dy * projection);
      const distanceSq = offsetX * offsetX + offsetY * offsetY;
      if (distanceSq >= reachSq) continue;
      const distance = Math.sqrt(distanceSq);
      const coverage = 1 - smoothstep(half, reach, distance);
      if (coverage > 0) blendAt(data, (rowIndex + px) * 4, color, clamp(colorAlpha * coverage, 0, 1));
    }
  }
}

/**
 * Opaque whole-buffer fill. Doubling copyWithin runs at memcpy speed, where the
 * per-pixel blend path costs most of a chart raster on its own.
 */
export function fillOpaque(data: Uint8Array, color: RgbaColor) {
  const recording = rasterRecorderFor(data);
  if (recording) {
    recording.ops.push(1, color.r, color.g, color.b);
    return;
  }
  if (data.length < 4) return;
  data[0] = color.r;
  data[1] = color.g;
  data[2] = color.b;
  data[3] = 255;
  let filled = 4;
  while (filled < data.length) {
    const chunk = Math.min(filled, data.length - filled);
    data.copyWithin(filled, 0, chunk);
    filled += chunk;
  }
}

export function fillRect(
  data: Uint8Array,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  color: RgbaColor,
  opacity = 1,
) {
  const recording = rasterRecorderFor(data);
  if (recording) {
    recording.ops.push(2, left, top, right, bottom, color.r, color.g, color.b, color.a, opacity);
    return;
  }
  const alpha = clamp((color.a / 255) * opacity, 0, 1);
  if (alpha <= 0) return;
  const startX = Math.max(Math.floor(left), 0);
  const endX = Math.min(Math.ceil(right), width - 1);
  for (let y = Math.max(Math.floor(top), 0); y <= Math.min(Math.ceil(bottom), height - 1); y++) {
    const rowIndex = y * width;
    for (let x = startX; x <= endX; x++) blendAt(data, (rowIndex + x) * 4, color, alpha);
  }
}

export function drawCircle(
  data: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  color: RgbaColor,
) {
  const recording = rasterRecorderFor(data);
  if (recording) {
    recording.ops.push(4, centerX, centerY, radius, color.r, color.g, color.b, color.a);
    return;
  }
  const minX = Math.floor(centerX - radius - 1);
  const maxX = Math.ceil(centerX + radius + 1);
  const minY = Math.floor(centerY - radius - 1);
  const maxY = Math.ceil(centerY + radius + 1);

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const distance = Math.hypot(px + 0.5 - centerX, py + 0.5 - centerY);
      const coverage = 1 - smoothstep(radius - 0.65, radius + 0.65, distance);
      if (coverage > 0) {
        blendPixel(data, width, height, px, py, color, coverage);
      }
    }
  }
}

/** A circle's outline, `thickness` pixels wide, centred on `radius`. */
export function drawRing(
  data: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  thickness: number,
  color: RgbaColor,
) {
  const half = thickness / 2;
  const minX = Math.floor(centerX - radius - half - 1);
  const maxX = Math.ceil(centerX + radius + half + 1);
  const minY = Math.floor(centerY - radius - half - 1);
  const maxY = Math.ceil(centerY + radius + half + 1);

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const offset = Math.abs(Math.hypot(px + 0.5 - centerX, py + 0.5 - centerY) - radius);
      const coverage = 1 - smoothstep(half - 0.5, half + 0.5, offset);
      if (coverage > 0) {
        blendPixel(data, width, height, px, py, color, coverage);
      }
    }
  }
}
