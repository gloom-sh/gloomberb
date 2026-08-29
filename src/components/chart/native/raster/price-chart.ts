import { measurePerf } from "../../../../utils/perf-marks";
import type { ChartScene } from "../../core/renderer";
import type { ChartRenderMode } from "../../core/types";
import {
  clamp,
  drawAreaFill,
  drawLine,
  fillRect,
  lerp,
  parseHex,
  type RgbaColor,
} from "./primitives";
import type { NativeChartBitmap } from "./types";
import {
  drawPriceGrid,
  drawSessionBackgroundSpans,
  getChartPixelLayout,
  getNativeBarMetrics,
  isHighLowMode,
  isOhlcLikeMode,
  projectChartX,
  projectX,
  projectY,
} from "./layout";

function drawWickOutsideBody(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  highY: number,
  lowY: number,
  bodyTop: number,
  bodyBottom: number,
  color: RgbaColor,
) {
  if (highY < bodyTop) {
    drawLine(data, width, height, x, highY, x, bodyTop, color, 1.2);
  }
  if (bodyBottom < lowY) {
    drawLine(data, width, height, x, bodyBottom, x, lowY, color, 1.2);
  }
}

function drawLineSeries(
  data: Uint8Array,
  width: number,
  height: number,
  scene: ChartScene,
  top: number,
  bottom: number,
) {
  const fallbackGlow = parseHex(scene.colors.lineColor, 0.2);
  const fallbackLine = parseHex(scene.colors.lineColor, 0.95);
  const fill = parseHex(scene.colors.fillColor, 0.7);
  const yByColumn = new Float32Array(width).fill(Number.POSITIVE_INFINITY);
  const strokeCache = new Map<string, { glow: ReturnType<typeof parseHex>; line: ReturnType<typeof parseHex> }>();

  for (let index = 0; index < scene.points.length - 1; index++) {
    const current = scene.points[index]!;
    const next = scene.points[index + 1]!;
    const x0 = projectX(index, scene.points.length, 0, width - 1);
    const x1 = projectX(index + 1, scene.points.length, 0, width - 1);
    const y0 = projectY(current.close, scene.min, scene.max, top, bottom);
    const y1 = projectY(next.close, scene.min, scene.max, top, bottom);

    const start = Math.max(Math.floor(Math.min(x0, x1)), 0);
    const end = Math.min(Math.ceil(Math.max(x0, x1)), width - 1);
    for (let x = start; x <= end; x++) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      const y = lerp(y0, y1, clamp(t, 0, 1));
      yByColumn[x] = Math.min(yByColumn[x]!, y);
    }

    const hex = scene.lineColors?.[index];
    let glow = fallbackGlow;
    let line = fallbackLine;
    if (hex) {
      let stroke = strokeCache.get(hex);
      if (!stroke) {
        stroke = { glow: parseHex(hex, 0.2), line: parseHex(hex, 0.95) };
        strokeCache.set(hex, stroke);
      }
      glow = stroke.glow;
      line = stroke.line;
    }

    if (scene.mode === "area") {
      drawLine(data, width, height, x0, y0, x1, y1, glow, 4);
      drawLine(data, width, height, x0, y0, x1, y1, line, 1.75);
    } else {
      drawLine(data, width, height, x0, y0, x1, y1, glow, 3.2);
      drawLine(data, width, height, x0, y0, x1, y1, line, 1.4);
    }
  }

  if (scene.mode === "area") {
    drawAreaFill(data, width, height, yByColumn, bottom, fill);
  }
}

function drawCandles(
  data: Uint8Array,
  width: number,
  height: number,
  scene: ChartScene,
  top: number,
  bottom: number,
  mode: Extract<ChartRenderMode, "candles" | "ohlc" | "hlc">,
) {
  const { bodyWidth, tickLength, stemThickness } = getNativeBarMetrics(scene.points.length, width, mode);
  const horizontalPad = isOhlcLikeMode(mode)
    ? Math.ceil(Math.max(tickLength - 1, stemThickness / 2, 0))
    : Math.ceil(bodyWidth / 2);
  const plotLeft = horizontalPad;
  const plotRight = Math.max(width - 1 - horizontalPad, plotLeft);

  for (let index = 0; index < scene.points.length; index++) {
    const point = scene.points[index]!;
    const x = projectX(index, scene.points.length, plotLeft, plotRight);
    const highY = projectY(point.high, scene.min, scene.max, top, bottom);
    const lowY = projectY(point.low, scene.min, scene.max, top, bottom);
    const openY = projectY(point.open, scene.min, scene.max, top, bottom);
    const closeY = projectY(point.close, scene.min, scene.max, top, bottom);
    const isUp = point.close >= point.open;

    const wickColor = parseHex(isUp ? scene.colors.wickUp : scene.colors.wickDown, 0.92);
    const bodyColor = parseHex(isUp ? scene.colors.candleUp : scene.colors.candleDown, 1);

    if (isOhlcLikeMode(mode)) {
      drawLine(data, width, height, x, highY, x, lowY, wickColor, stemThickness);
      if (mode === "ohlc") {
        drawLine(data, width, height, x - tickLength, openY, x, openY, bodyColor, Math.max(stemThickness, 1.4));
      }
      drawLine(data, width, height, x, closeY, x + tickLength, closeY, bodyColor, Math.max(stemThickness, 1.4));
      continue;
    }

    const bodyTop = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    if (Math.abs(bodyBottom - bodyTop) < 1.25) {
      drawLine(data, width, height, x, highY, x, lowY, wickColor, 1.2);
      drawLine(data, width, height, x - bodyWidth / 2, bodyTop, x + bodyWidth / 2, bodyTop, bodyColor, 1.5);
    } else {
      drawWickOutsideBody(data, width, height, x, highY, lowY, bodyTop, bodyBottom, wickColor);
      fillRect(data, width, height, x - bodyWidth / 2, bodyTop, x + bodyWidth / 2, bodyBottom, bodyColor, 1);
    }
  }
}

function drawVolume(
  data: Uint8Array,
  width: number,
  height: number,
  scene: ChartScene,
  top: number,
  bottom: number,
) {
  if (!scene.showVolume || bottom < top) return;

  const volumes = scene.points.map((point) => point.volume);
  const maxVolume = Math.max(...volumes, 1);
  const spacing = width / Math.max(scene.points.length, 1);
  const barWidth = clamp(spacing * 0.72, 1, Math.max(spacing, 1));

  for (let index = 0; index < scene.points.length; index++) {
    const point = scene.points[index]!;
    const heightRatio = point.volume / maxVolume;
    if (heightRatio <= 0) continue;
    const x = projectX(index, scene.points.length, 0, width - 1);
    const barTop = lerp(bottom, top, heightRatio);
    const isUp = isHighLowMode(scene.mode)
      ? point.close >= point.open
      : index === 0 || point.close >= scene.points[index - 1]!.close;
    const color = parseHex(isUp ? scene.colors.volumeUp : scene.colors.volumeDown, 0.6);
    fillRect(data, width, height, x - barWidth / 2, barTop, x + barWidth / 2, bottom, color, 0.8);
  }
}

function drawIndicatorOverlays(
  data: Uint8Array,
  width: number,
  height: number,
  scene: ChartScene,
  top: number,
  bottom: number,
) {
  if (!scene.indicators) return;

  const drawOverlay = (points: { index: number; value: number }[], color: string) => {
    const lineColor = parseHex(color, 0.95);
    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = points[index]!;
      const p1 = points[index + 1]!;
      const x0 = projectChartX(p0.index, scene.points.length, width, scene.mode);
      const y0 = projectY(p0.value, scene.min, scene.max, top, bottom);
      const x1 = projectChartX(p1.index, scene.points.length, width, scene.mode);
      const y1 = projectY(p1.value, scene.min, scene.max, top, bottom);
      drawLine(data, width, height, x0, y0, x1, y1, lineColor, 1.2);
    }
  };

  for (const sma of scene.indicators.smaLines) {
    drawOverlay(sma.points, sma.color);
  }
  for (const ema of scene.indicators.emaLines) {
    drawOverlay(ema.points, ema.color);
  }
  if (scene.indicators.bollinger) {
    drawOverlay(scene.indicators.bollinger.upper, scene.indicators.bollinger.color);
    drawOverlay(scene.indicators.bollinger.middle, scene.indicators.bollinger.color);
    drawOverlay(scene.indicators.bollinger.lower, scene.indicators.bollinger.color);
  }
}

export function renderNativeChartBase(scene: ChartScene, pixelWidth: number, pixelHeight: number): NativeChartBitmap {
  return measurePerf("chart.native.base", () => {
    const pixels = new Uint8Array(pixelWidth * pixelHeight * 4);
    if (scene.points.length === 0 || pixelWidth <= 0 || pixelHeight <= 0) {
      return { width: Math.max(pixelWidth, 1), height: Math.max(pixelHeight, 1), pixels };
    }

    const layout = getChartPixelLayout(scene, pixelWidth, pixelHeight);
    drawSessionBackgroundSpans(
      pixels,
      pixelWidth,
      pixelHeight,
      scene.sessionBackgroundSpans,
      scene.points.length,
      layout.plotTop,
      scene.showVolume ? layout.volumeBottom : layout.plotBottom,
      scene.colors,
      (index) => projectX(index, scene.points.length, 0, Math.max(pixelWidth - 1, 0)),
    );
    drawPriceGrid(pixels, pixelWidth, pixelHeight, scene, layout.plotTop, layout.plotBottom);
    drawIndicatorOverlays(pixels, pixelWidth, pixelHeight, scene, layout.plotTop, layout.plotBottom);

    switch (scene.mode) {
      case "area":
      case "line":
        drawLineSeries(pixels, pixelWidth, pixelHeight, scene, layout.plotTop, layout.plotBottom);
        break;
      case "candles":
        drawCandles(pixels, pixelWidth, pixelHeight, scene, layout.plotTop, layout.plotBottom, "candles");
        break;
      case "ohlc":
        drawCandles(pixels, pixelWidth, pixelHeight, scene, layout.plotTop, layout.plotBottom, "ohlc");
        break;
      case "hlc":
        drawCandles(pixels, pixelWidth, pixelHeight, scene, layout.plotTop, layout.plotBottom, "hlc");
        break;
    }

    drawVolume(pixels, pixelWidth, pixelHeight, scene, layout.volumeTop, layout.volumeBottom);

    return { width: pixelWidth, height: pixelHeight, pixels };
  }, { pixelWidth, pixelHeight, points: scene.points.length, mode: scene.mode });
}
