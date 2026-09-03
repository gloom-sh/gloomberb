export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function smoothstep(edge0: number, edge1: number, value: number): number {
  const range = edge1 - edge0;
  if (range === 0) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / range, 0, 1);
  return t * t * (3 - 2 * t);
}

export function parseHex(hex: string, alpha = 1): RgbaColor {
  const normalized = hex.replace("#", "");
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
    a: Math.round(clamp(alpha, 0, 1) * 255),
  };
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
  if (x < 0 || y < 0 || x >= width || y >= height) return;

  const alpha = clamp((color.a / 255) * opacity, 0, 1);
  if (alpha <= 0) return;

  const index = (y * width + x) * 4;
  const dstAlpha = data[index + 3]! / 255;
  const outAlpha = alpha + dstAlpha * (1 - alpha);

  if (outAlpha <= 0) return;

  const dstFactor = dstAlpha * (1 - alpha);
  data[index] = Math.round((color.r * alpha + data[index]! * dstFactor) / outAlpha);
  data[index + 1] = Math.round((color.g * alpha + data[index + 1]! * dstFactor) / outAlpha);
  data[index + 2] = Math.round((color.b * alpha + data[index + 2]! * dstFactor) / outAlpha);
  data[index + 3] = Math.round(outAlpha * 255);
}

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
  const half = thickness / 2;
  const minX = Math.floor(Math.min(x0, x1) - half - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1);
  const minY = Math.floor(Math.min(y0, y1) - half - 1);
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const segmentLengthSq = dx * dx + dy * dy || 1;

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const projection = clamp(((cx - x0) * dx + (cy - y0) * dy) / segmentLengthSq, 0, 1);
      const nearestX = x0 + dx * projection;
      const nearestY = y0 + dy * projection;
      const distance = Math.hypot(cx - nearestX, cy - nearestY);
      const coverage = 1 - smoothstep(half, half + 1.1, distance);
      if (coverage > 0) {
        blendPixel(data, width, height, px, py, color, coverage);
      }
    }
  }
}

/**
 * Opaque whole-buffer fill. Doubling copyWithin runs at memcpy speed, where the
 * per-pixel blend path costs most of a chart raster on its own.
 */
export function fillOpaque(data: Uint8Array, color: RgbaColor) {
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
  for (let y = Math.max(Math.floor(top), 0); y <= Math.min(Math.ceil(bottom), height - 1); y++) {
    for (let x = Math.max(Math.floor(left), 0); x <= Math.min(Math.ceil(right), width - 1); x++) {
      blendPixel(data, width, height, x, y, color, opacity);
    }
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
