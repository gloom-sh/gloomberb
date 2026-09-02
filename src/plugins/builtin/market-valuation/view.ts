import { vintageLabel, type RatioPoint, type ValuationSeries } from "./align";
import { meanRatio, projectChart, type ValuationChartProjection } from "./chart-projection";
import {
  RANGE_WINDOWS_MS,
  classifyZone,
  higherIsExpensive,
  type IndicatorDef,
  type ValuationRangeId,
  type ZoneHit,
} from "./defs";
import { sigmaVsTrend, trendAt, type TrendFit } from "./trend";

const MS_PER_DAY = 86_400_000;

export interface Extreme {
  ratio: number;
  date: string;
}

export interface IndicatorBuild {
  indicator: IndicatorDef;
  series: ValuationSeries;
  trend: TrendFit;
}

export interface ValuationBundle {
  builds: IndicatorBuild[];
  errors: string[];
  fetchedAt: number;
}

export interface IndicatorViewModel {
  indicator: IndicatorDef;
  range: ValuationRangeId;
  current: RatioPoint;
  zone: ZoneHit;
  /** Raw fit deviation, in the indicator's own direction. */
  sigmaVsTrend: number;
  /** Deviation restated so positive always means expensive. */
  richSigma: number;
  /** Share of history this market was cheaper than, so 100 is the richest ever. */
  richPercentile: number;
  trendNow: number;
  mean: number;
  vintageLabel: string | null;
  ratioOneYearAgo: number | null;
  allTimeHigh: Extreme;
  allTimeLow: Extreme;
  percentile: number;
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
  nowMs: number = Date.parse(points.at(-1)!.date),
): RatioPoint[] {
  const window = RANGE_WINDOWS_MS[range];
  if (window == null) return [...points];
  const cutoff = nowMs - window;
  const sliced = points.filter((p) => parseDateMs(p.date) >= cutoff);
  return sliced.length >= 2 ? sliced : [...points];
}

function findExtreme(points: readonly RatioPoint[], pick: "high" | "low"): Extreme {
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
  const points = series.points;
  const current = points[points.length - 1]!;
  const nowMs = opts.nowMs ?? Date.now();
  const visible = sliceByRange(points, range);
  const mean = meanRatio(points);
  const atOrBelow = points.filter((p) => p.ratio <= current.ratio).length;
  const percentile = points.length === 0 ? 0 : (100 * atOrBelow) / points.length;
  const sigma = sigmaVsTrend(trend, current.ratio, current.date);
  const expensiveUp = higherIsExpensive(indicator);

  return {
    indicator,
    range,
    current,
    zone: classifyZone(indicator, current.ratio),
    sigmaVsTrend: sigma,
    richSigma: expensiveUp ? sigma : -sigma,
    richPercentile: expensiveUp ? percentile : 100 - percentile,
    trendNow: trendAt(trend, current.date),
    mean,
    vintageLabel: indicator.input.kind === "ratio" && indicator.input.levels
      ? vintageLabel(indicator.input.levels.denominatorLabel, series.vintageDate)
      : null,
    ratioOneYearAgo: ratioOneYearAgo(points, current.date),
    allTimeHigh: findExtreme(points, "high"),
    allTimeLow: findExtreme(points, "low"),
    percentile,
    chart: projectChart(indicator, visible, mean),
    asOf: current.date,
    observationStale: nowMs - parseDateMs(current.date) > indicator.staleAfterMs,
  };
}

export function selectValuationViews(
  bundle: ValuationBundle,
  range: ValuationRangeId,
): IndicatorViewModel[] {
  return bundle.builds.map((build) => projectView(build, range));
}
