import { vintageLabel, type RatioPoint, type RatioSeries } from "./align";
import { meanRatio, projectChart, type ValuationChartProjection } from "./chart-projection";
import {
  RANGE_WINDOWS_MS,
  classifyZone,
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
  series: RatioSeries;
  trend: TrendFit;
  cacheStale: boolean;
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
  sigmaVsTrend: number;
  trendNow: number;
  mean: number;
  denominatorVintageLabel: string;
  ratioOneYearAgo: number | null;
  allTimeHigh: Extreme;
  allTimeLow: Extreme;
  percentile: number;
  chart: ValuationChartProjection;
  asOf: string;
  observationStale: boolean;
  cacheStale: boolean;
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
  const { indicator, series, trend, cacheStale } = build;
  const points = series.points;
  const current = points[points.length - 1]!;
  const nowMs = opts.nowMs ?? Date.now();
  const visible = sliceByRange(points, range);
  const mean = meanRatio(points);
  const atOrBelow = points.filter((p) => p.ratio <= current.ratio).length;

  return {
    indicator,
    range,
    current,
    zone: classifyZone(indicator, current.ratio),
    sigmaVsTrend: sigmaVsTrend(trend, current.ratio, current.date),
    trendNow: trendAt(trend, current.date),
    mean,
    denominatorVintageLabel: vintageLabel(indicator.denominatorLabel, series.denominatorVintageDate),
    ratioOneYearAgo: ratioOneYearAgo(points, current.date),
    allTimeHigh: findExtreme(points, "high"),
    allTimeLow: findExtreme(points, "low"),
    percentile: points.length === 0 ? 0 : (100 * atOrBelow) / points.length,
    chart: projectChart(indicator, visible, mean),
    asOf: current.date,
    observationStale: nowMs - parseDateMs(current.date) > indicator.staleAfterMs,
    cacheStale,
  };
}

export function selectValuationViews(
  bundle: ValuationBundle,
  range: ValuationRangeId,
): IndicatorViewModel[] {
  return bundle.builds.map((build) => projectView(build, range));
}
