import type { ProjectedChartPoint } from "../core/data";
import type {
  ChartColors,
  ChartIndicatorOverlays,
  ChartRenderMode,
  ChartSessionBackgroundSpan,
  PixelBuffer,
} from "../core/types";
import {
  drawLine,
  fillBackgroundRect,
  fillColumn,
  fillRect,
  LAYER_DATA,
  LAYER_FILL,
  LAYER_OVERLAY,
  setPixel,
} from "./pixel-buffer";
import {
  getBarHalfWidth,
  getCandleHalfWidth,
  getDotX,
  getOhlcStemWidth,
  getOhlcTickLength,
  getScaledY,
  getTimePointBand,
} from "./geometry";

type VolumeTrendMode = "previousClose" | "openClose";

function drawWickOutsideBody(
  buf: PixelBuffer,
  x: number,
  highY: number,
  lowY: number,
  bodyTop: number,
  bodyBottom: number,
  color: string,
) {
  if (highY < bodyTop) {
    drawLine(buf, x, highY, x, bodyTop, color, LAYER_DATA);
  }
  if (bodyBottom < lowY) {
    drawLine(buf, x, bodyBottom, x, lowY, color, LAYER_DATA);
  }
}

function getSessionBackgroundColor(span: ChartSessionBackgroundSpan, colors: ChartColors): string {
  return span.kind === "pre" ? colors.preMarketBgColor : colors.postMarketBgColor;
}

export function drawSessionBackgrounds(
  buf: PixelBuffer,
  points: ProjectedChartPoint[],
  spans: readonly ChartSessionBackgroundSpan[],
  yTop: number,
  yBottom: number,
  colors: ChartColors,
) {
  if (spans.length === 0 || points.length === 0) return;
  for (const span of spans) {
    const startIndex = Math.max(Math.min(span.startIndex, points.length - 1), 0);
    const endIndex = Math.max(Math.min(span.endIndex, points.length - 1), startIndex);
    const startBand = getTimePointBand(startIndex, points.length, buf.width);
    const endBand = getTimePointBand(endIndex, points.length, buf.width);
    fillBackgroundRect(buf, startBand.left, yTop, endBand.right, yBottom, getSessionBackgroundColor(span, colors));
  }
}

export function drawLineSeries(
  buf: PixelBuffer,
  points: ProjectedChartPoint[],
  chartTop: number,
  chartBottom: number,
  lineColor: string,
  min: number,
  max: number,
  lineColors?: readonly string[] | null,
) {
  if (points.length === 0) return;

  for (let i = 0; i < points.length; i++) {
    const x = getDotX(i, points.length, buf.width, "line");
    const y = getScaledY(points[i]!.close, min, max, chartTop, chartBottom);
    const color = lineColors?.[i] ?? lineColor;
    if (i < points.length - 1) {
      const x1 = getDotX(i + 1, points.length, buf.width, "line");
      const y1 = getScaledY(points[i + 1]!.close, min, max, chartTop, chartBottom);
      drawLine(buf, x, y, x1, y1, color, LAYER_DATA);
    } else {
      setPixel(buf, x, y, color, LAYER_DATA);
    }
  }
}

export function drawAreaChart(
  buf: PixelBuffer,
  points: ProjectedChartPoint[],
  chartTop: number,
  chartBottom: number,
  lineColor: string,
  fillColor: string,
  min: number,
  max: number,
) {
  if (points.length === 0) return;

  for (let i = 0; i < points.length; i++) {
    const x = getDotX(i, points.length, buf.width, "area");
    const y = getScaledY(points[i]!.close, min, max, chartTop, chartBottom);

    fillColumn(buf, x, y + 1, chartBottom, fillColor, LAYER_FILL);

    if (i < points.length - 1) {
      const x1 = getDotX(i + 1, points.length, buf.width, "area");
      const y1 = getScaledY(points[i + 1]!.close, min, max, chartTop, chartBottom);

      for (let cx = Math.min(x, x1); cx <= Math.max(x, x1); cx++) {
        if (cx === x || cx === x1) continue;
        const t = (cx - x) / Math.max(Math.abs(x1 - x), 1);
        const iy = Math.round(y + t * (y1 - y));
        fillColumn(buf, cx, iy + 1, chartBottom, fillColor, LAYER_FILL);
      }

      drawLine(buf, x, y, x1, y1, lineColor, LAYER_DATA);
    } else {
      setPixel(buf, x, y, lineColor, LAYER_DATA);
    }
  }
}

export function drawCandlestickChart(
  buf: PixelBuffer,
  points: ProjectedChartPoint[],
  chartTop: number,
  chartBottom: number,
  palette: ResolvedChartPalette,
  min: number,
  max: number,
) {
  const halfW = getCandleHalfWidth(points.length, buf.width);

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const x = getDotX(i, points.length, buf.width, "candles");
    const highY = getScaledY(point.high, min, max, chartTop, chartBottom);
    const lowY = getScaledY(point.low, min, max, chartTop, chartBottom);
    const openY = getScaledY(point.open, min, max, chartTop, chartBottom);
    const closeY = getScaledY(point.close, min, max, chartTop, chartBottom);
    const isUp = point.close >= point.open;
    const wickColor = isUp ? palette.wickUp : palette.wickDown;
    const bodyColor = isUp ? palette.candleUp : palette.candleDown;

    const bodyTop = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    if (bodyTop === bodyBottom) {
      drawLine(buf, x, highY, x, lowY, wickColor, LAYER_DATA);
      const dojiBottom = Math.min(bodyBottom + 1, chartBottom);
      const dojiTop = Math.max(chartTop, dojiBottom - 1);
      fillRect(buf, x - halfW, dojiTop, x + halfW, dojiBottom, bodyColor, LAYER_DATA);
    } else {
      drawWickOutsideBody(buf, x, highY, lowY, bodyTop, bodyBottom, wickColor);
      fillRect(buf, x - halfW, bodyTop, x + halfW, bodyBottom, bodyColor, LAYER_DATA);
    }
  }
}

export function drawOhlcChart(
  buf: PixelBuffer,
  points: ProjectedChartPoint[],
  chartTop: number,
  chartBottom: number,
  palette: ResolvedChartPalette,
  min: number,
  max: number,
  mode: Extract<ChartRenderMode, "ohlc" | "hlc">,
) {
  const tickLen = getOhlcTickLength(points.length, buf.width);
  const stemWidth = getOhlcStemWidth(points.length, buf.width);
  const stemLeft = Math.floor((stemWidth - 1) / 2);
  const stemRight = Math.ceil((stemWidth - 1) / 2);

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const x = getDotX(i, points.length, buf.width, mode);
    const highY = getScaledY(point.high, min, max, chartTop, chartBottom);
    const lowY = getScaledY(point.low, min, max, chartTop, chartBottom);
    const openY = getScaledY(point.open, min, max, chartTop, chartBottom);
    const closeY = getScaledY(point.close, min, max, chartTop, chartBottom);
    const isUp = point.close >= point.open;
    const color = isUp ? palette.candleUp : palette.candleDown;

    for (let dx = -stemLeft; dx <= stemRight; dx++) {
      drawLine(buf, x + dx, highY, x + dx, lowY, color, LAYER_DATA);
    }

    if (mode === "ohlc") {
      for (let dx = 0; dx < tickLen; dx++) {
        setPixel(buf, x - dx, openY, color, LAYER_DATA);
      }
    }
    for (let dx = 0; dx < tickLen; dx++) {
      setPixel(buf, x + dx, closeY, color, LAYER_DATA);
    }
  }
}

export function drawVolumeBars(
  buf: PixelBuffer,
  points: ProjectedChartPoint[],
  yTop: number,
  yBottom: number,
  upColor: string,
  downColor: string,
  trendMode: VolumeTrendMode,
  mode: ChartRenderMode,
) {
  const volumes = points.map((point) => point.volume);
  const maxVol = Math.max(...volumes, 1);
  const volH = yBottom - yTop;
  const halfW = getBarHalfWidth(points.length, buf.width);

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const x = getDotX(i, points.length, buf.width, mode);
    const barH = Math.round((point.volume / maxVol) * volH);
    if (barH === 0) continue;

    const isUp = trendMode === "openClose"
      ? point.close >= point.open
      : i === 0 || point.close >= points[i - 1]!.close;
    const color = isUp ? upColor : downColor;

    fillRect(buf, x - halfW, yBottom - barH, x + halfW, yBottom, color, LAYER_FILL);
  }
}

export function drawIndicatorOverlays(
  buf: PixelBuffer,
  indicators: ChartIndicatorOverlays,
  pointCount: number,
  dotTop: number,
  dotBottom: number,
  min: number,
  max: number,
  mode: ChartRenderMode,
): void {
  const drawOverlay = (overlayPoints: { index: number; value: number }[], color: string) => {
    for (let i = 0; i < overlayPoints.length - 1; i++) {
      const p0 = overlayPoints[i]!;
      const p1 = overlayPoints[i + 1]!;
      const x0 = getDotX(p0.index, pointCount, buf.width, mode);
      const y0 = getScaledY(p0.value, min, max, dotTop, dotBottom);
      const x1 = getDotX(p1.index, pointCount, buf.width, mode);
      const y1 = getScaledY(p1.value, min, max, dotTop, dotBottom);
      drawLine(buf, x0, y0, x1, y1, color, LAYER_OVERLAY);
    }
  };

  for (const sma of indicators.smaLines) {
    drawOverlay(sma.points, sma.color);
  }
  for (const ema of indicators.emaLines) {
    drawOverlay(ema.points, ema.color);
  }
  if (indicators.bollinger) {
    drawOverlay(indicators.bollinger.upper, indicators.bollinger.color);
    drawOverlay(indicators.bollinger.middle, indicators.bollinger.color);
    drawOverlay(indicators.bollinger.lower, indicators.bollinger.color);
  }
  for (const reference of indicators.referenceLines ?? []) {
    const y = getScaledY(reference.value, min, max, dotTop, dotBottom);
    drawLine(buf, 0, y, Math.max(buf.width - 1, 0), y, reference.color, LAYER_OVERLAY);
  }
}
