import type { StatBuild } from "./client";
import type { StatDef } from "./defs";
import { periodsPerYear, type StatPoint } from "./transform";
import { sigmaVsTrend, trendAt } from "./trend";

export type StatRangeId = "5Y" | "20Y" | "ALL";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export const STAT_RANGE_WINDOWS_MS: { readonly [K in StatRangeId]: number | null } = {
  "5Y": 5 * MS_PER_YEAR,
  "20Y": 20 * MS_PER_YEAR,
  ALL: null,
};

export interface StatViewModel {
  stat: StatDef;
  range: StatRangeId;
  latest: StatPoint;
  /** The print before this one, for the direction of the last move. */
  previous: StatPoint | null;
  yearAgo: StatPoint | null;
  changeOnPrevious: number | null;
  /** Where the current reading sits in the series' own history. */
  percentile: number;
  sigmaVsTrend: number;
  mean: number;
  high: StatPoint;
  low: StatPoint;
  visible: StatPoint[];
  observationStale: boolean;
}

export function sliceByRange(
  points: readonly StatPoint[],
  range: StatRangeId,
): StatPoint[] {
  const window = STAT_RANGE_WINDOWS_MS[range];
  if (window == null || points.length === 0) return [...points];
  const cutoff = Date.parse(points.at(-1)!.date) - window;
  const sliced = points.filter((point) => Date.parse(point.date) >= cutoff);
  return sliced.length >= 2 ? sliced : [...points];
}

function extreme(points: readonly StatPoint[], pick: "high" | "low"): StatPoint {
  let best = points[0]!;
  for (const point of points) {
    if (pick === "high" ? point.value > best.value : point.value < best.value) best = point;
  }
  return best;
}

export function projectStat(
  build: StatBuild,
  range: StatRangeId,
  opts: { nowMs?: number } = {},
): StatViewModel {
  const { stat, points, trend } = build;
  const latest = points[points.length - 1]!;
  const nowMs = opts.nowMs ?? Date.now();
  const perYear = periodsPerYear(points.map((point) => ({ date: point.date, value: point.value })));
  const yearAgo = points[points.length - 1 - perYear] ?? null;
  const previous = points[points.length - 2] ?? null;
  const atOrBelow = points.filter((point) => point.value <= latest.value).length;

  return {
    stat,
    range,
    latest,
    previous,
    yearAgo,
    changeOnPrevious: previous ? latest.value - previous.value : null,
    percentile: points.length === 0 ? 0 : (100 * atOrBelow) / points.length,
    sigmaVsTrend: sigmaVsTrend(trend, latest.value, latest.date),
    mean: points.reduce((total, point) => total + point.value, 0) / points.length,
    high: extreme(points, "high"),
    low: extreme(points, "low"),
    visible: sliceByRange(points, range),
    observationStale: nowMs - Date.parse(latest.date) > stat.staleAfterMs,
  };
}

export function selectStatViews(
  builds: readonly StatBuild[],
  range: StatRangeId,
): StatViewModel[] {
  return builds.map((build) => projectStat(build, range));
}

export { trendAt };
