import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type { ChartIndicatorOverlays } from "../../../components/chart/core/types";
import { blendHex, colors } from "../../../theme/colors";
import type { RatioPoint } from "./align";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import {
  classifyZone,
  shortZoneLabel,
  zoneColor,
  type IndicatorDef,
  type ValuationZoneId,
} from "./defs";

export interface ChartMarkerLine {
  value: number;
  label: string;
}

export interface ValuationChartProjection {
  points: ProjectedChartPoint[];
  /** The ratio points behind the projection, for the interactive chart. */
  sourcePoints: RatioPoint[];
  overlays: ChartIndicatorOverlays;
  yDomain: { min: number; max: number };
  yearLabels: string[];
  lineColors: string[];
  /** Captions the pane positions against the plot; the renderer draws lines only. */
  markers: ChartMarkerLine[];
}

/** Snaps to whole grid steps, and opens a floor when the measure can go negative. */
export function niceDomain(
  dataMin: number,
  dataMax: number,
  step: number,
): { min: number; max: number } {
  const span = step > 0 ? step : 1;
  const hi = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
  const lo = Number.isFinite(dataMin) ? Math.min(0, dataMin) : 0;
  return {
    min: lo < 0 ? Math.floor(lo / span) * span : 0,
    max: Math.max(span, Math.ceil(hi / span) * span),
  };
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
  let yMin = Infinity;
  for (const point of visible) {
    yMax = Math.max(yMax, point.ratio);
    yMin = Math.min(yMin, point.ratio);
  }
  if (!Number.isFinite(yMax)) yMax = 0;
  if (!Number.isFinite(yMin)) yMin = 0;
  if (indicator.reference) {
    yMax = Math.max(yMax, indicator.reference.value);
    yMin = Math.min(yMin, indicator.reference.value);
  }
  yMax = Math.max(yMax, mean);
  yMin = Math.min(yMin, mean);

  const markers: ChartMarkerLine[] = [];
  const referenceLines = [];
  if (indicator.reference) {
    referenceLines.push({ value: indicator.reference.value, color: colors.textDim });
    markers.push({ value: indicator.reference.value, label: indicator.reference.label });
  }
  if (Number.isFinite(mean)) {
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
    sourcePoints: [...visible],
    overlays,
    yDomain: niceDomain(yMin, yMax, indicator.chartGridStep),
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

/**
 * CompositeChart draws one colour per series, so the zone gradient is carried by
 * one series per zone that holds nulls everywhere the ratio sits in another band.
 * A run keeps its neighbours' boundary points so the segments join without gaps.
 */
export function zoneSeriesFor(
  indicator: IndicatorDef,
  points: readonly RatioPoint[],
): ResolvedSeries[] {
  const byZone = new Map<ValuationZoneId, TimeSeriesPoint[]>();
  const zones = points.map((point) => classifyZone(indicator, point.ratio));
  for (const band of indicator.zones) {
    if (!byZone.has(band.id)) byZone.set(band.id, []);
  }

  points.forEach((point, index) => {
    const date = new Date(point.date);
    const here = zones[index]!.id;
    const before = zones[index - 1]?.id;
    const after = zones[index + 1]?.id;
    for (const [zoneId, series] of byZone) {
      // Carry a boundary point into the neighbouring run so the line is continuous.
      const belongs = zoneId === here || zoneId === before || zoneId === after;
      series.push({ date, observedAt: date, value: belongs ? point.ratio : null });
    }
  });

  const built: ResolvedSeries[] = [];
  for (const [zoneId, series] of byZone) {
    if (!series.some((entry) => entry.value != null)) continue;
    built.push({
      id: `zone:${zoneId}`,
      label: shortZoneLabel(zoneId),
      color: zoneColor(zoneId),
      unit: indicator.axisUnit,
      unitGroup: indicator.axisUnit === "%" ? "valuation-percent" : "valuation",
      nativeFrequency: "daily",
      dataShape: "scalar",
      style: "line",
      transform: "raw",
      axis: "left",
      panelId: "main",
      interpolation: "none",
      points: series,
    });
  }
  return built;
}

/** Flat line at a fixed level, for parity, replacement cost, or the sample mean. */
export function markerSeries(
  indicator: IndicatorDef,
  id: string,
  label: string,
  value: number,
  color: string,
  points: readonly RatioPoint[],
): ResolvedSeries | null {
  if (points.length === 0 || !Number.isFinite(value)) return null;
  const ends = [points[0]!, points[points.length - 1]!].map((point) => {
    const date = new Date(point.date);
    return { date, observedAt: date, value };
  });
  return {
    id,
    label,
    color,
    unit: indicator.axisUnit,
    unitGroup: indicator.axisUnit === "%" ? "valuation-percent" : "valuation",
    nativeFrequency: "daily",
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    points: ends,
  };
}
