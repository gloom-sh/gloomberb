import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type { ChartIndicatorOverlays } from "../../../components/chart/core/types";
import { blendHex, colors } from "../../../theme/colors";
import type { RatioPoint } from "./align";
import { classifyZone, type IndicatorDef } from "./defs";

export interface ChartMarkerLine {
  value: number;
  label: string;
}

export interface ValuationChartProjection {
  points: ProjectedChartPoint[];
  overlays: ChartIndicatorOverlays;
  yDomain: { min: number; max: number };
  yearLabels: string[];
  lineColors: string[];
  /** Captions the pane positions against the plot; the renderer draws lines only. */
  markers: ChartMarkerLine[];
}

export function niceDomain(dataMax: number, step: number): { min: number; max: number } {
  const hi = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
  const span = step > 0 ? step : 1;
  return { min: 0, max: Math.max(span, Math.ceil(hi / span) * span) };
}

export function meanRatio(points: readonly RatioPoint[]): number {
  if (points.length === 0) return 0;
  let total = 0;
  for (const point of points) total += point.ratio;
  return total / points.length;
}

/**
 * @param visible points inside the selected range, which is what gets drawn
 * @param mean full-history average, so the anchor does not move when the range changes
 */
export function projectChart(
  indicator: IndicatorDef,
  visible: readonly RatioPoint[],
  mean: number,
): ValuationChartProjection {
  const points: ProjectedChartPoint[] = visible.map((p) => ({
    date: new Date(p.date),
    open: p.ratio,
    high: p.ratio,
    low: p.ratio,
    close: p.ratio,
    volume: 0,
  }));

  let yMax = -Infinity;
  for (const point of visible) yMax = Math.max(yMax, point.ratio);
  if (!Number.isFinite(yMax)) yMax = 0;
  if (indicator.reference) yMax = Math.max(yMax, indicator.reference.value);
  if (mean > 0) yMax = Math.max(yMax, mean);

  const markers: ChartMarkerLine[] = [];
  const referenceLines = [];
  if (indicator.reference) {
    referenceLines.push({ value: indicator.reference.value, color: colors.textDim });
    markers.push({ value: indicator.reference.value, label: indicator.reference.label });
  }
  if (mean > 0) {
    referenceLines.push({ value: mean, color: blendHex(colors.textDim, colors.bg, 0.35) });
    markers.push({ value: mean, label: "mean" });
  }

  const overlays: ChartIndicatorOverlays = {
    smaLines: [],
    emaLines: [],
    bollinger: null,
    rsi: null,
    macd: null,
    referenceLines,
  };

  return {
    points,
    overlays,
    yDomain: niceDomain(yMax, indicator.chartGridStep),
    yearLabels: chartYearLabels(points),
    lineColors: visible.map((point) => classifyZone(indicator, point.ratio).color),
    markers,
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
