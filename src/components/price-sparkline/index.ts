import type { PricePoint } from "../../types/financials";

// Braille cells pack a 2x4 dot grid; these are the Unicode bit offsets by dot.
const BRAILLE_DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const;
const BRAILLE_BASE = 0x2800;

function plotLine(
  dots: Uint8Array,
  dotWidth: number,
  dotHeight: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps);
    const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    if (x >= 0 && x < dotWidth && y >= 0 && y < dotHeight) dots[y * dotWidth + x] = 1;
  }
}

/** Draws closes as a braille line, one text row per cell row. */
function renderBrailleSparkline(values: readonly number[], width: number, height: number): string[] {
  const cellWidth = Math.max(1, Math.floor(width));
  const cellHeight = Math.max(1, Math.floor(height));
  const dotWidth = cellWidth * 2;
  const dotHeight = cellHeight * 4;
  const dots = new Uint8Array(dotWidth * dotHeight);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const toX = (index: number) => (index / Math.max(values.length - 1, 1)) * (dotWidth - 1);
  const toY = (value: number) => (1 - (value - min) / range) * (dotHeight - 1);
  for (let index = 1; index < values.length; index += 1) {
    plotLine(dots, dotWidth, dotHeight, toX(index - 1), toY(values[index - 1]!), toX(index), toY(values[index]!));
  }
  const rows: string[] = [];
  for (let row = 0; row < cellHeight; row += 1) {
    let text = "";
    for (let column = 0; column < cellWidth; column += 1) {
      let bits = 0;
      for (let dx = 0; dx < 2; dx += 1) {
        for (let dy = 0; dy < 4; dy += 1) {
          if (dots[(row * 4 + dy) * dotWidth + column * 2 + dx]) bits |= BRAILLE_DOT_BITS[dx]![dy]!;
        }
      }
      text += String.fromCharCode(BRAILLE_BASE + bits);
    }
    rows.push(text);
  }
  return rows;
}

/** Text fallback for terminals without pixel graphics: the top row of a braille line. */
export function renderPriceSparkline(
  priceHistory: PricePoint[],
  options: { width?: number; height?: number; maxPoints?: number } = {},
): string | null {
  if (priceHistory.length < 2) return null;
  const width = Math.max(4, Math.floor(options.width ?? 10));
  const height = Math.max(1, Math.floor(options.height ?? 1));
  const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? Math.max(20, width * 2)));
  const values = priceHistory.slice(-maxPoints)
    .map((point) => point.close)
    .filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  return renderBrailleSparkline(values, width, height)[0] ?? null;
}
