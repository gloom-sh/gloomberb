import type { PixelBuffer } from "./types";
import type { ProjectedChartPoint } from "./data";
import { buildTimeAxis } from "./time-axis";
import {
  formatAxisValue,
  getAxisFractionDigitFloor,
  resolveAxisFractionDigits,
} from "./axis-format";
import {
  bufferToBrailleLines,
  createPixelBuffer,
  drawCrosshair,
  drawGridLines,
  type StyledContent,
} from "../rendering/pixel-buffer";
import {
  isHighLowMode,
} from "../rendering/geometry";
import {
  drawAreaChart,
  drawCandlestickChart,
  drawIndicatorOverlays,
  drawLineSeries,
  drawOhlcChart,
  drawSessionBackgrounds,
  drawVolumeBars,
} from "../rendering/chart-draw";
import {
  buildChartScene,
  type RenderChartOptions,
} from "./scene";

export { buildCursorTimeAxisSegments, buildTimeAxis } from "./time-axis";
export {
  formatAxisCell,
  formatAxisValue,
  formatCursorAxisValue,
  formatPrice,
  resolveAxisFractionDigits,
  resolveChartAxisWidth,
} from "./axis-format";
export { resolveChartPalette } from "./palette";
export type { ResolvedChartPalette } from "./palette";
export {
  bufferToBrailleLines,
  createPixelBuffer,
  drawCrosshair,
  drawGridLines,
  drawLine,
} from "../rendering/pixel-buffer";
export { getPointTerminalColumn } from "../rendering/geometry";
export type { StyledContent } from "../rendering/pixel-buffer";
export {
  buildChartScene,
  getActivePointIndex,
  type ChartScene,
  type RenderChartOptions,
} from "./scene";

// ---------------------------------------------------------------------------
// Grid lines & price axis
// ---------------------------------------------------------------------------

export function computeGridLines(
  min: number,
  max: number,
  chartTop: number,
  chartBottom: number,
  numLines: number,
): { y: number; price: number }[] {
  const range = max - min || 1;
  const chartH = chartBottom - chartTop;
  const result: { y: number; price: number }[] = [];

  for (let i = 0; i <= numLines; i++) {
    const frac = i / numLines;
    result.push({
      y: chartTop + Math.round(frac * chartH),
      price: max - frac * range,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main render entry point
// ---------------------------------------------------------------------------

export interface RenderChartResult {
  lines: StyledContent[];
  axisLabels: { row: number; label: string }[];
  timeLabels: string;
  activePoint: ProjectedChartPoint | null;
  priceAtCursor: number | null;
  crosshairPrice: number | null;
  dateAtCursor: Date | null;
  changeAtCursor: number | null;
  changePctAtCursor: number | null;
  cursorColumn: number | null;
  cursorRow: number | null;
  axisFractionDigits: number | null;
  priceRange: number | null;
  /** Raw pixel buffer for GPU/Kitty rendering path */
  pixelBuffer: PixelBuffer | null;
}

export function renderChart(
  points: ProjectedChartPoint[],
  opts: RenderChartOptions,
): RenderChartResult {
  const scene = buildChartScene(points, opts);
  if (!scene) {
    return {
      lines: [],
      axisLabels: [],
      timeLabels: "",
      activePoint: null,
      priceAtCursor: null,
      crosshairPrice: null,
      dateAtCursor: null,
      changeAtCursor: null,
      changePctAtCursor: null,
      cursorColumn: null,
      cursorRow: null,
      axisFractionDigits: null,
      priceRange: null,
      pixelBuffer: null,
    };
  }

  const { width, height, showVolume, volumeHeight, colors: palette, mode } = scene;
  const axisMode = opts.axisMode ?? "price";
  const currency = opts.currency ?? "USD";
  const assetCategory = opts.assetCategory;

  // Braille resolution: 2 dot-columns per terminal column, 4 dot-rows per terminal row
  const dotWidth = width * 2;
  const volTermRows = showVolume ? volumeHeight : 0;
  const chartTermRows = height - volTermRows;
  const totalDotH = height * 4;
  const chartDotBottom = chartTermRows * 4 - 1;
  const volDotTop = chartTermRows * 4;
  const volDotBottom = totalDotH - 1;

  const buf = createPixelBuffer(dotWidth, totalDotH);
  const { min, max } = scene;
  const priceRange = max - min;

  const gridLines = computeGridLines(min, max, 0, chartDotBottom, 3);
  const axisFractionDigits = axisMode === "price"
    ? resolveAxisFractionDigits(
      gridLines.map((line) => line.price),
      (price, fixedFractionDigits) => formatAxisValue(
        price,
        axisMode,
        points[0]!.close,
        currency,
        assetCategory,
        priceRange,
        fixedFractionDigits,
      ),
      getAxisFractionDigitFloor(assetCategory, priceRange),
    )
    : null;
  drawSessionBackgrounds(
    buf,
    points,
    scene.sessionBackgroundSpans,
    0,
    showVolume ? volDotBottom : chartDotBottom,
    palette,
  );
  drawGridLines(buf, gridLines.map((line) => line.y), palette.gridColor);

  switch (mode) {
    case "area":
      drawAreaChart(buf, points, 0, chartDotBottom, palette.lineColor, palette.fillColor, min, max);
      break;
    case "line":
      drawLineSeries(buf, points, 0, chartDotBottom, palette.lineColor, min, max, scene.lineColors);
      break;
    case "candles":
      drawCandlestickChart(buf, points, 0, chartDotBottom, palette, min, max);
      break;
    case "ohlc":
      drawOhlcChart(buf, points, 0, chartDotBottom, palette, min, max, "ohlc");
      break;
    case "hlc":
      drawOhlcChart(buf, points, 0, chartDotBottom, palette, min, max, "hlc");
      break;
  }

  if (showVolume && volTermRows > 0) {
    drawVolumeBars(
      buf,
      points,
      volDotTop,
      volDotBottom,
      palette.volumeUp,
      palette.volumeDown,
      isHighLowMode(mode) ? "openClose" : "previousClose",
      mode,
    );
  }

  if (opts.indicators) {
    drawIndicatorOverlays(buf, opts.indicators, points.length, 0, chartDotBottom, min, max, mode);
  }

  // Cursor mapping stays in terminal-column space
  const { activePoint, priceAtCursor, crosshairPrice, dateAtCursor, changeAtCursor, changePctAtCursor } = scene;

  if (scene.cursorDotX !== null) {
    drawCrosshair(buf, scene.cursorDotX, 0, showVolume ? volDotBottom : chartDotBottom, palette.crosshairColor);
  }

  const axisLabelsByRow = new Map<number, string>();
  for (const line of gridLines) {
    axisLabelsByRow.set(
      Math.min(Math.floor(line.y / 4), Math.max(chartTermRows - 1, 0)),
      formatAxisValue(line.price, axisMode, points[0]!.close, currency, assetCategory, priceRange, axisFractionDigits ?? undefined),
    );
  }

  const timeAxisDates = opts.timeAxisDates ?? points.map((point) => point.date);

  return {
    lines: bufferToBrailleLines(buf),
    axisLabels: [...axisLabelsByRow.entries()].map(([row, label]) => ({ row, label })),
    timeLabels: buildTimeAxis(timeAxisDates, width),
    activePoint,
    priceAtCursor,
    crosshairPrice,
    dateAtCursor,
    changeAtCursor,
    changePctAtCursor,
    cursorColumn: scene.cursorColumn,
    cursorRow: scene.cursorRow,
    axisFractionDigits,
    priceRange,
    pixelBuffer: buf,
  };
}
