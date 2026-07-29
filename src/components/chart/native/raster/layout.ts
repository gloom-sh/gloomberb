import { computeGridLines, type ChartScene } from "../../core/renderer";
import type { ChartColors, ChartRenderMode, ChartSessionBackgroundSpan } from "../../core/types";
import {
  clamp,
  drawLine,
  fillRect,
  lerp,
  parseHex,
} from "./primitives";
import type { PixelRect } from "./types";

export function getChartPixelLayout(scene: ChartScene, pixelWidth: number, pixelHeight: number) {
  const volumeHeight = scene.showVolume ? Math.max(Math.round((scene.volumeHeight / Math.max(scene.height, 1)) * pixelHeight), 1) : 0;
  const plotHeight = Math.max(pixelHeight - volumeHeight, 1);
  return {
    plotLeft: 0,
    plotTop: 0,
    plotRight: Math.max(pixelWidth - 1, 0),
    plotBottom: Math.max(plotHeight - 1, 0),
    volumeTop: plotHeight,
    volumeBottom: Math.max(pixelHeight - 1, plotHeight),
  };
}

export function projectX(index: number, count: number, left: number, right: number): number {
  if (count <= 1) return (left + right) / 2;
  return lerp(left, right, index / (count - 1));
}

export function isOhlcLikeMode(mode: ChartRenderMode): boolean {
  return mode === "ohlc" || mode === "hlc";
}

export function isHighLowMode(
  mode: ChartRenderMode,
): mode is Extract<ChartRenderMode, "candles" | "ohlc" | "hlc"> {
  return mode === "candles" || isOhlcLikeMode(mode);
}

export function getNativeBarMetrics(count: number, width: number, mode: Extract<ChartRenderMode, "candles" | "ohlc" | "hlc">) {
  const spacing = width / Math.max(count, 1);
  if (mode === "candles") {
    return {
      bodyWidth: clamp(spacing * 0.58, 2, Math.max(spacing - 1, 2)),
      tickLength: 0,
      stemThickness: 1.2,
    };
  }

  return {
    bodyWidth: 0,
    tickLength: clamp(spacing * 0.5, 3, Math.max(spacing * 0.62, 3)),
    stemThickness: clamp(spacing * 0.12, 2, 3.2),
  };
}

export function projectChartX(index: number, count: number, width: number, mode: ChartRenderMode): number {
  if (!isHighLowMode(mode)) {
    return projectX(index, count, 0, Math.max(width - 1, 0));
  }

  const { bodyWidth, tickLength, stemThickness } = getNativeBarMetrics(count, width, mode);
  const horizontalPad = isOhlcLikeMode(mode)
    ? Math.ceil(Math.max(tickLength - 1, stemThickness / 2, 0))
    : Math.ceil(bodyWidth / 2);
  return projectX(index, count, horizontalPad, Math.max(width - 1 - horizontalPad, horizontalPad));
}

function getProjectedPointBand(
  index: number,
  count: number,
  width: number,
  projectIndex: (targetIndex: number) => number,
): PixelRect {
  const currentX = projectIndex(index);
  const previousX = index > 0 ? projectIndex(index - 1) : currentX;
  const nextX = index < count - 1 ? projectIndex(index + 1) : currentX;
  const left = index === 0 ? 0 : Math.floor((previousX + currentX) / 2) + 1;
  const right = index === count - 1 ? Math.max(width - 1, 0) : Math.floor((currentX + nextX) / 2);
  return {
    x: clamp(left, 0, Math.max(width - 1, 0)),
    y: 0,
    width: Math.max(clamp(right, 0, Math.max(width - 1, 0)) - clamp(left, 0, Math.max(width - 1, 0)) + 1, 1),
    height: 1,
  };
}

export function drawSessionBackgroundSpans(
  data: Uint8Array,
  width: number,
  height: number,
  spans: readonly ChartSessionBackgroundSpan[],
  pointCount: number,
  top: number,
  bottom: number,
  colors: Pick<ChartColors, "preMarketBgColor" | "postMarketBgColor">,
  projectIndex: (targetIndex: number) => number,
) {
  if (spans.length === 0 || pointCount === 0) return;
  for (const span of spans) {
    const startIndex = clamp(span.startIndex, 0, pointCount - 1);
    const endIndex = clamp(span.endIndex, startIndex, pointCount - 1);
    const startBand = getProjectedPointBand(startIndex, pointCount, width, projectIndex);
    const endBand = getProjectedPointBand(endIndex, pointCount, width, projectIndex);
    const color = parseHex(span.kind === "pre" ? colors.preMarketBgColor : colors.postMarketBgColor, 1);
    fillRect(data, width, height, startBand.x, top, endBand.x + endBand.width - 1, bottom, color, 1);
  }
}

export function projectY(value: number, min: number, max: number, top: number, bottom: number): number {
  const range = max - min || 1;
  return lerp(bottom, top, (value - min) / range);
}

export function drawPriceGrid(
  data: Uint8Array,
  width: number,
  height: number,
  scene: ChartScene,
  top: number,
  bottom: number,
) {
  const gridLines = computeGridLines(scene.min, scene.max, top, bottom, 3);
  const color = parseHex(scene.colors.gridColor, 0.28);

  for (const line of gridLines) {
    drawLine(data, width, height, 0, line.y, width - 1, line.y, color, 1);
  }
}
