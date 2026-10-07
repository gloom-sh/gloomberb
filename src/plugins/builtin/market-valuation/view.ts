import { isUsableRatio, vintageLabel, type RatioPoint, type ValuationSeries } from "./align";
import { meanRatio, projectChart, type ValuationChartProjection } from "./chart-projection";
import {
  RANGE_WINDOWS_MS,
  classifyZone,
  higherIsExpensive,
  type IndicatorDef,
  type ValuationRangeId,
  type ZoneHit,
} from "./defs";
import { fitTrend, sigmaVsTrend, trendAt, type TrendFit } from "../shared/trend";

const MS_PER_DAY = 86_400_000;

interface Extreme {
  ratio: number;
  date: string;
}

export interface IndicatorBuild {
  indicator: IndicatorDef;
  series: ValuationSeries;
  trend: TrendFit;
  sourceStale?: boolean;
}

/** The trend through an indicator's ratios, in the model its measure calls for. */
export function fitIndicatorTrend(indicator: IndicatorDef, points: readonly RatioPoint[]): TrendFit {
  return fitTrend(points.map((point) => ({ date: point.date, value: point.ratio })), indicator.trendModel);
}

export interface ValuationBundle {
  builds: IndicatorBuild[];
  errors: string[];
  fetchedAt: number | null;
  sources?: Record<string, import("./series").ValuationSourceMetadata>;
}

export interface IndicatorViewModel {
  indicator: IndicatorDef;
  range: ValuationRangeId;
  current: RatioPoint;
  zone: ZoneHit | null;
  /** Raw fit deviation, in the indicator's own direction. */
  sigmaVsTrend: number | null;
  /** Deviation restated so positive always means expensive. */
  richSigma: number | null;
  /** Share of history this market was cheaper than, so 100 is the richest ever. */
  richPercentile: number | null;
  trendNow: number;
  mean: number;
  vintageLabel: string | null;
  ratioOneYearAgo: number | null;
  allTimeHigh: Extreme;
  allTimeLow: Extreme;
  percentile: number | null;
  chart: ValuationChartProjection;
  asOf: string;
  observationStale: boolean;
}

function parseDateMs(date: string): number {
  return Date.parse(date);
}

export function sliceByRange(
  points: readonly RatioPoint[],
  range: ValuationRangeId,
  nowMs: number = Date.parse(points.at(-1)?.date ?? ""),
): RatioPoint[] {
  const window = RANGE_WINDOWS_MS[range];
  if (window == null) return [...points];
  const cutoff = nowMs - window;
  return points.filter((p) => parseDateMs(p.date) >= cutoff && parseDateMs(p.date) <= nowMs);
}

function findExtreme(points: readonly (RatioPoint & { ratio: number })[], pick: "high" | "low"): Extreme {
  let best = points[0]!;
  for (const p of points) {
    if (pick === "high" ? p.ratio > best.ratio : p.ratio < best.ratio) best = p;
  }
  return { ratio: best.ratio, date: best.date };
}

function ratioOneYearAgo(points: readonly RatioPoint[], currentDate: string): number | null {
  const cutoff = parseDateMs(currentDate) - 365 * MS_PER_DAY;
  let found: RatioPoint | null = null;
  for (const p of points) {
    if (parseDateMs(p.date) <= cutoff) found = p;
  }
  return found?.ratio ?? null;
}

export function projectView(
  build: IndicatorBuild,
  range: ValuationRangeId,
  opts: { nowMs?: number } = {},
): IndicatorViewModel {
  const { indicator, series, trend } = build;
  const history = series.points;
  const points = history.filter(isUsableRatio);
  const current = history.at(-1)!;
  const nowMs = opts.nowMs ?? Date.now();
  const visible = sliceByRange(history, range);
  const mean = meanRatio(points);
  const atOrBelow = points.filter((p) => current.ratio != null && p.ratio <= current.ratio).length;
  const percentile = current.ratio == null ? null : (100 * atOrBelow) / points.length;
  const sigma = current.ratio == null ? null : sigmaVsTrend(trend, current.ratio, current.date);
  const expensiveUp = higherIsExpensive(indicator);

  return {
    indicator,
    range,
    current,
    zone: current.ratio == null ? null : classifyZone(indicator, current.ratio),
    sigmaVsTrend: sigma,
    richSigma: sigma == null ? null : expensiveUp ? sigma : -sigma,
    richPercentile: percentile == null ? null : expensiveUp ? percentile : 100 - percentile,
    trendNow: trendAt(trend, current.date),
    mean,
    vintageLabel: indicator.input.kind === "ratio" && indicator.input.levels
      ? vintageLabel(indicator.input.levels.denominatorLabel, series.vintageDate)
      : null,
    ratioOneYearAgo: ratioOneYearAgo(history, current.date),
    allTimeHigh: findExtreme(points, "high"),
    allTimeLow: findExtreme(points, "low"),
    percentile,
    chart: projectChart(indicator, visible, mean),
    asOf: current.date,
    observationStale: build.sourceStale === true || nowMs - parseDateMs(current.date) > indicator.staleAfterMs,
  };
}

export function selectValuationViews(
  bundle: ValuationBundle,
  range: ValuationRangeId,
): IndicatorViewModel[] {
  return bundle.builds.map((build) => projectView(build, range));
}
