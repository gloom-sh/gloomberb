import { drawCircle, drawLine, parseHex } from "./primitives";
import type { CellRect, NativeChartBitmap } from "./types";

interface CrosshairMarker {
  pixelY: number;
  color: string;
}

export interface CrosshairStripsOptions {
  /** Cursor position in plot pixels; a null level draws only the column. */
  pixelX: number;
  pixelY: number | null;
  /** Plot size in pixels and cells. */
  pixelWidth: number;
  pixelHeight: number;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  color: string;
  markers?: readonly CrosshairMarker[];
}

export interface CrosshairStrip {
  /** Cell rect relative to the plot's top-left cell. */
  rect: CellRect;
  bitmap: NativeChartBitmap;
  /** Stable identity for the strip contents. */
  key: string;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function bitmap(width: number, height: number): NativeChartBitmap {
  const pixels = new Uint8Array(Math.max(width, 1) * Math.max(height, 1) * 4);
  return { width: Math.max(width, 1), height: Math.max(height, 1), pixels };
}

/**
 * Crosshair lines as two thin strips instead of a plot-sized overlay: a cursor
 * move then re-encodes a few kilobytes rather than the whole plot bitmap.
 */
export function renderCrosshairStrips(options: CrosshairStripsOptions): CrosshairStrip[] {
  const { cellWidth, cellHeight, cols, rows, pixelWidth, pixelHeight } = options;
  if (cols <= 0 || rows <= 0 || cellWidth <= 0 || cellHeight <= 0) return [];

  const x = clamp(options.pixelX, 0, Math.max(pixelWidth - 1, 0));
  const y = options.pixelY === null ? null : clamp(options.pixelY, 0, Math.max(pixelHeight - 1, 0));
  const lineColor = parseHex(options.color, 0.78);
  const focusColor = parseHex(options.color, 0.32);
  const strips: CrosshairStrip[] = [];

  // Vertical strip: wide enough for the focus dot and the series markers.
  const verticalCols = Math.min(3, cols);
  const verticalStart = clamp(Math.floor(x / cellWidth) - 1, 0, cols - verticalCols);
  const verticalWidth = Math.max(1, Math.round(verticalCols * cellWidth));
  const vertical = bitmap(verticalWidth, pixelHeight);
  const localX = clamp(x - verticalStart * cellWidth, 0, vertical.width - 1);
  drawLine(vertical.pixels, vertical.width, vertical.height, localX, 0, localX, vertical.height - 1, lineColor, 1.05);
  for (const marker of options.markers ?? []) {
    const markerY = clamp(marker.pixelY, 0, Math.max(pixelHeight - 1, 0));
    drawCircle(vertical.pixels, vertical.width, vertical.height, localX, markerY, 2.6, parseHex(marker.color));
  }
  if (y !== null) drawCircle(vertical.pixels, vertical.width, vertical.height, localX, y, 2.1, focusColor);
  strips.push({
    rect: { x: verticalStart, y: 0, width: verticalCols, height: rows },
    bitmap: vertical,
    key: `v:${verticalStart}:${localX.toFixed(2)}:${y === null ? "-" : y.toFixed(2)}`,
  });
  if (y === null) return strips;

  // Horizontal strip: a single cell row carrying the level line.
  const horizontalStart = clamp(Math.floor(y / cellHeight), 0, rows - 1);
  const horizontalHeight = Math.max(1, Math.round(cellHeight));
  const horizontal = bitmap(pixelWidth, horizontalHeight);
  const localY = clamp(y - horizontalStart * cellHeight, 0, horizontal.height - 1);
  drawLine(horizontal.pixels, horizontal.width, horizontal.height, 0, localY, horizontal.width - 1, localY, lineColor, 1.05);
  strips.push({
    rect: { x: 0, y: horizontalStart, width: cols, height: 1 },
    bitmap: horizontal,
    key: `h:${horizontalStart}:${localY.toFixed(2)}`,
  });

  return strips;
}
