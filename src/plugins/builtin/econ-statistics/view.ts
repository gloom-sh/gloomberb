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
  /** The latest print's period at the series' own cadence: "Sep 21", "Aug", "Q2". */
  period: string;
  /** The print before this one, for the direction of the last move. */
  previous: StatPoint | null;
  yearAgo: StatPoint | null;
  changeOnPrevious: number | null;
  /** Where the current reading sits within the selected range. */
  percentile: number;
  sigmaVsTrend: number;
  mean: number;
  high: StatPoint;
  low: StatPoint;
  visible: StatPoint[];
  observationStale: boolean;
  fetchedAt: number | null;
  cacheStale: boolean | null;
  cacheSource: NonNullable<StatBuild["cache"]>["source"] | null;
  refreshError: string | null;
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Rows mix daily, weekly, monthly and quarterly prints, so each names its own period. */
export function formatStatPeriod(date: string, perYear: number): string {
  const month = Number(date.slice(5, 7));
  const name = MONTHS[month - 1];
  if (!name) return date;
  if (perYear <= 4) return `Q${Math.ceil(month / 3)}`;
  if (perYear <= 12) return name;
  return `${name} ${Number(date.slice(8, 10))}`;
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
  const yearEarlier = new Date(latest.date);
  const year = yearEarlier.getUTCFullYear() - 1;
  const month = yearEarlier.getUTCMonth();
  const day = Math.min(yearEarlier.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  yearEarlier.setTime(Date.UTC(year, month, day));
  const target = yearEarlier.toISOString().slice(0, 10);
  // Monthly/quarterly releases are calendar periods. Daily series can use the
  // nearest preceding business day, but never an arbitrary row count.
  const yearAgo = perYear <= 12
    ? points.find((point) => point.date.slice(0, 7) === target.slice(0, 7)) ?? null
    : [...points].reverse().find((point) => point.date <= target &&
      Date.parse(target) - Date.parse(point.date) <= (perYear === 52 ? 7 : 4) * 86_400_000) ?? null;
  const previous = points[points.length - 2] ?? null;
  // High, low, mean and percentile describe the selected window, like the chart.
  const visible = sliceByRange(points, range);
  const atOrBelow = visible.filter((point) => point.value <= latest.value).length;

  return {
    stat,
    range,
    latest,
    period: formatStatPeriod(latest.date, perYear),
    previous,
    yearAgo,
    changeOnPrevious: previous ? latest.value - previous.value : null,
    percentile: visible.length === 0 ? 0 : (100 * atOrBelow) / visible.length,
    sigmaVsTrend: sigmaVsTrend(trend, latest.value, latest.date),
    mean: visible.reduce((total, point) => total + point.value, 0) / visible.length,
    high: extreme(visible, "high"),
    low: extreme(visible, "low"),
    visible,
    observationStale: nowMs - Date.parse(latest.date) > stat.staleAfterMs,
    fetchedAt: build.cache?.fetchedAt ?? null,
    cacheStale: build.cache?.stale ?? null,
    cacheSource: build.cache?.source ?? null,
    refreshError: build.cache?.refreshError ?? null,
  };
}

export function selectStatViews(
  builds: readonly StatBuild[],
  range: StatRangeId,
): StatViewModel[] {
  return builds.map((build) => projectStat(build, range));
}

export { trendAt };
