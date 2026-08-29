import type {
  ChartAxisMode,
  ChartIndicatorOverlays,
  ChartMarketSession,
  ChartRenderMode,
  ChartSessionBackgroundSpan,
} from "./types";
import type { ProjectedChartPoint } from "./data";
import { resolveExtendedHoursBackgroundSpans } from "../market-session";
import { normalizeCount } from "./render-utils";
import { buildTimeAxis } from "./time-axis";
import { type ResolvedChartPalette } from "./palette";
import {
  getPointTerminalColumn,
  isHighLowMode,
} from "../rendering/geometry";

function normalizeRenderDimensions(opts: RenderChartOptions) {
  const width = normalizeCount(opts.width, 1);
  const height = normalizeCount(opts.height, 1);
  const volumeHeight = opts.showVolume
    ? Math.min(normalizeCount(opts.volumeHeight, 0), Math.max(height - 1, 0))
    : 0;
  const showVolume = opts.showVolume && volumeHeight > 0;
  return {
    width,
    height,
    showVolume,
    volumeHeight,
    chartRows: Math.max(height - volumeHeight, 1),
  };
}

export interface RenderChartOptions {
  width: number;
  height: number;
  showVolume: boolean;
  volumeHeight: number;
  cursorX: number | null;
  cursorY: number | null;
  mode: ChartRenderMode;
  axisMode?: ChartAxisMode;
  currency?: string;
  assetCategory?: string;
  colors: ResolvedChartPalette;
  timeAxisDates?: Array<Date | string | number>;
  indicators?: ChartIndicatorOverlays | null;
  marketSession?: ChartMarketSession | null;
  yDomain?: { min: number; max: number };
}

export interface ChartScene {
  points: ProjectedChartPoint[];
  width: number;
  height: number;
  showVolume: boolean;
  volumeHeight: number;
  chartRows: number;
  mode: ChartRenderMode;
  colors: ResolvedChartPalette;
  indicators: ChartIndicatorOverlays | null;
  sessionBackgroundSpans: ChartSessionBackgroundSpan[];
  min: number;
  max: number;
  activeIdx: number;
  activePoint: ProjectedChartPoint;
  priceAtCursor: number;
  crosshairPrice: number | null;
  dateAtCursor: Date;
  changeAtCursor: number;
  changePctAtCursor: number;
  timeLabels: string;
  cursorX: number | null;
  cursorY: number | null;
  cursorColumn: number | null;
  cursorRow: number | null;
  cursorDotX: number | null;
}

export function getActivePointIndex(
  pointCount: number,
  width: number,
  cursorX: number | null,
  mode: ChartRenderMode,
): number {
  if (pointCount <= 0) return 0;
  if (cursorX === null || cursorX < 0 || cursorX >= width) {
    return pointCount - 1;
  }

  let bestIndex = pointCount - 1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < pointCount; index += 1) {
    const pointColumn = getPointTerminalColumn(index, pointCount, width, mode);
    const distance = Math.abs(pointColumn - cursorX);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

export function buildChartScene(
  points: ProjectedChartPoint[],
  opts: RenderChartOptions,
): ChartScene | null {
  if (points.length === 0) return null;

  const dimensions = normalizeRenderDimensions(opts);
  const dataMin = isHighLowMode(opts.mode)
    ? Math.min(...points.map((point) => point.low))
    : Math.min(...points.map((point) => point.close));
  const dataMax = isHighLowMode(opts.mode)
    ? Math.max(...points.map((point) => point.high))
    : Math.max(...points.map((point) => point.close));
  const domainMin = opts.yDomain && Number.isFinite(opts.yDomain.min) ? opts.yDomain.min : dataMin;
  const domainMax = opts.yDomain && Number.isFinite(opts.yDomain.max) ? opts.yDomain.max : dataMax;
  const min = domainMin;
  const max = domainMax > domainMin ? domainMax : domainMin + 1;
  const activeIdx = getActivePointIndex(points.length, dimensions.width, opts.cursorX, opts.mode);
  const activePoint = points[activeIdx]!;
  const range = max - min || 1;
  const cursorX = opts.cursorX === null
    ? null
    : Math.min(Math.max(opts.cursorX, 0), Math.max(dimensions.width - 1, 0));
  const cursorColumn = cursorX === null
    ? null
    : Math.round(cursorX);
  const cursorDotX = cursorX === null
    ? null
    : Math.round((cursorX / Math.max(dimensions.width - 1, 1)) * Math.max(dimensions.width * 2 - 1, 0));
  const cursorY = cursorX === null
    ? null
    : opts.cursorY !== null
      ? Math.min(Math.max(opts.cursorY, 0), Math.max(dimensions.chartRows - 1, 0))
      : Math.min(
        Math.max(Math.round((1 - (activePoint.close - min) / range) * Math.max(dimensions.chartRows - 1, 0)), 0),
        Math.max(dimensions.chartRows - 1, 0),
      );
  const cursorRow = cursorY === null
    ? null
    : Math.round(cursorY);
  const crosshairPrice = cursorY === null
    ? null
    : max - (cursorY / Math.max(dimensions.chartRows - 1, 1)) * range;

  const timeAxisDates = opts.timeAxisDates ?? points.map((point) => point.date);
  const sessionBackgroundSpans = resolveExtendedHoursBackgroundSpans(
    points.map((point) => point.date),
    opts.marketSession,
  );

  return {
    points,
    width: dimensions.width,
    height: dimensions.height,
    showVolume: dimensions.showVolume,
    volumeHeight: dimensions.volumeHeight,
    chartRows: dimensions.chartRows,
    mode: opts.mode,
    colors: opts.colors,
    indicators: opts.indicators ?? null,
    sessionBackgroundSpans,
    min,
    max,
    activeIdx,
    activePoint,
    priceAtCursor: activePoint.close,
    crosshairPrice,
    dateAtCursor: activePoint.date,
    changeAtCursor: activePoint.close - points[0]!.close,
    changePctAtCursor: points[0]!.close ? ((activePoint.close - points[0]!.close) / points[0]!.close) * 100 : 0,
    timeLabels: buildTimeAxis(timeAxisDates, dimensions.width),
    cursorX,
    cursorY,
    cursorColumn,
    cursorRow,
    cursorDotX,
  };
}
