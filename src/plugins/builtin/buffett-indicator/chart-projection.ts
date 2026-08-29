import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type { ChartIndicatorOverlays } from "../../../components/chart/core/types";
import { colors } from "../../../theme/colors";
import type { RatioPoint } from "./align";
import { PARITY_RATIO, classifyZone } from "./defs";

export interface BuffettChartProjection {
  points: ProjectedChartPoint[];
  overlays: ChartIndicatorOverlays;
  yDomain: { min: number; max: number };
  yearLabels: string[];
  lineColors: string[];
}

/** Snap so three grid gaps land on 50% ticks. */
const PERCENT_GRID_SPAN = 150;

export function nicePercentDomain(dataMax: number): { min: number; max: number } {
  const hi = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
  return { min: 0, max: Math.max(PERCENT_GRID_SPAN, Math.ceil(hi / PERCENT_GRID_SPAN) * PERCENT_GRID_SPAN) };
}

export function projectChart(visible: readonly RatioPoint[]): BuffettChartProjection {
  const points: ProjectedChartPoint[] = visible.map((p) => ({
    date: new Date(p.date),
    open: p.ratio,
    high: p.ratio,
    low: p.ratio,
    close: p.ratio,
    volume: 0,
  }));
  let yMax = -Infinity;
  for (const point of visible) {
    yMax = Math.max(yMax, point.ratio);
  }
  if (!Number.isFinite(yMax)) yMax = 0;

  const overlays: ChartIndicatorOverlays = {
    smaLines: [],
    emaLines: [],
    bollinger: null,
    rsi: null,
    macd: null,
    referenceLines: [{ value: PARITY_RATIO, color: colors.textDim }],
  };

  return {
    points,
    overlays,
    yDomain: nicePercentDomain(yMax),
    yearLabels: chartYearLabels(points),
    lineColors: visible.map((point) => classifyZone(point.ratio).color),
  };
}

export function chartYearLabels(points: readonly ProjectedChartPoint[], maxLabels = 8): string[] {
  if (points.length === 0) return [];
  const years: string[] = [];
  for (const point of points) {
    const year = String(point.date.getFullYear());
    if (years[years.length - 1] !== year) years.push(year);
  }
  if (years.length <= maxLabels) return years;

  const start = Number(years[0]);
  const end = Number(years[years.length - 1]);
  let step = 5;
  while (Math.floor((end - start) / step) + 1 > maxLabels) {
    step = step === 5 ? 10 : step * 2;
    if (step > 100) break;
  }

  const picked: string[] = [years[0]!];
  for (const year of years) {
    if (Number(year) % step !== 0) continue;
    if (picked[picked.length - 1] !== year) picked.push(year);
  }
  const last = years[years.length - 1]!;
  if (picked[picked.length - 1] !== last) picked.push(last);
  return picked;
}
