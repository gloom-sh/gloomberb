import { subtractTimeRange } from "../../../../time-series/date-window";
import type { TimeRange } from "../../../../time-series/range";
import {
  CHART_RESOLUTION_STEP_MS,
  DEFAULT_CHART_RESOLUTION_SUPPORT,
  getSupportedChartResolutionsForViewport,
  isIntradayResolution,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../../../time-series/resolution";
import type { PricePoint } from "../../../../types/financials";
import { pricePointValues } from "../../../../utils/price-history-integrity";

export type ReturnRange = "6H" | "1D" | "5D" | TimeRange;

export const RETURN_RANGES: readonly ReturnRange[] = ["6H", "1D", "5D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"];

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The chart range whose interval limits cover this window. */
export function returnSupportRange(range: ReturnRange): TimeRange {
  if (range === "6H" || range === "1D") return "1D";
  if (range === "5D") return "1W";
  return range;
}

/** Where a window of `range` ending at `end` starts, by the UTC calendar charts use. */
export function returnWindowStart(range: ReturnRange, end: number): number {
  if (range === "6H") return end - 6 * HOUR_MS;
  if (range === "5D") return end - 5 * DAY_MS;
  return subtractTimeRange(new Date(end), range).getTime();
}

/**
 * Where the rows start, exclusive: the window's start for intraday bars. A
 * daily or longer bar is stamped with its date at midnight UTC, so the window
 * takes every bar from its start date on.
 */
export function returnVisibleFrom(range: ReturnRange, resolution: ManualChartResolution, end: number): number {
  const start = returnWindowStart(range, end);
  if (isIntradayResolution(resolution)) return start;
  const day = new Date(start);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime() - 1;
}

/**
 * A closed market leaves these windows without a bar when they end now, so
 * they end at the latest bar: on a weekend 1D is the last session.
 */
export function endsAtLatestBar(range: ReturnRange): boolean {
  return range === "6H" || range === "1D";
}

const WINDOW_DAYS: Record<ReturnRange, number> = {
  "6H": 0.25, "1D": 1, "5D": 5, "1W": 7, "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "5Y": 1827, ALL: Number.POSITIVE_INFINITY,
};

/** Covers a weekend and a holiday, so the bar before the window is loaded. */
function lookbackDays(resolution: ManualChartResolution): number {
  if (isIntradayResolution(resolution)) return 4;
  if (resolution === "1d") return 5;
  if (resolution === "1wk") return 21;
  return 62;
}

/**
 * How far before the window the request reaches. The bar just before the
 * window is the base of every return, so the request covers a weekend or
 * holiday before it, when that stays inside the history the source keeps at
 * this interval; otherwise it reaches back one interval.
 */
export function returnLookbackMs(
  range: ReturnRange,
  resolution: ManualChartResolution,
  support: readonly ChartResolutionSupport[],
): number {
  const maxRange = (support.length > 0 ? support : DEFAULT_CHART_RESOLUTION_SUPPORT)
    .find((entry) => entry.resolution === resolution)?.maxRange;
  const days = lookbackDays(resolution);
  if (maxRange && WINDOW_DAYS[range] + days < WINDOW_DAYS[maxRange]) return days * DAY_MS;
  return resolution === "1mo" ? 31 * DAY_MS : CHART_RESOLUTION_STEP_MS[resolution];
}

export function availableReturnResolutions(
  range: ReturnRange,
  support: readonly ChartResolutionSupport[],
): ManualChartResolution[] {
  return getSupportedChartResolutionsForViewport(
    returnSupportRange(range),
    support.length > 0 ? support : DEFAULT_CHART_RESOLUTION_SUPPORT,
  );
}

/** The chosen interval when the range allows it, else the nearest coarser one the source serves. */
export function effectiveReturnResolution(
  range: ReturnRange,
  resolution: ManualChartResolution,
  support: readonly ChartResolutionSupport[],
): ManualChartResolution {
  const available = availableReturnResolutions(range, support);
  if (available.includes(resolution)) return resolution;
  const step = CHART_RESOLUTION_STEP_MS[resolution];
  return available.find((candidate) => CHART_RESOLUTION_STEP_MS[candidate] >= step) ?? available.at(-1) ?? "1d";
}

export interface ReturnRow {
  key: string;
  timestamp: number;
  /** The bar's close; null when its prices contradict each other. */
  price: number | null;
  intervalChange: number | null;
  intervalPercent: number | null;
  cumulativeChange: number | null;
  cumulativePercent: number | null;
  /** The bar's OHLC contradict each other, so it takes no part in any return. */
  inconsistent: boolean;
}

interface Bar {
  timestamp: number;
  close: number | null;
  inconsistent: boolean;
}

function pointTime(point: PricePoint): number | null {
  const value = point.date instanceof Date ? point.date.getTime() : new Date(point.date).getTime();
  return Number.isFinite(value) ? value : null;
}

/** Chronological bars, one per timestamp (a repeated timestamp keeps its last value). */
function toBars(points: readonly PricePoint[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const point of points) {
    const timestamp = pointTime(point);
    if (timestamp === null) continue;
    const values = pricePointValues(point);
    byTime.set(timestamp, { timestamp, close: values.close, inconsistent: !!values.integrity });
  }
  return [...byTime.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function change(price: number | null, base: number | null): { change: number | null; percent: number | null } {
  if (price === null || base === null) return { change: null, percent: null };
  const value = price - base;
  return { change: value, percent: base === 0 ? null : value / base };
}

/**
 * Interval and cumulative price returns of the bars after `visibleFrom`
 * through `visibleTo`, newest first.
 *
 * The bar just before the window, when it was loaded, is the base: the first
 * row's interval runs from it and every cumulative return is measured against
 * it, so compounding the interval returns gives the cumulative one. Without
 * it (or when its prices are unusable), the first priced bar in the window is
 * the base and the window's first bar has no interval return. A
 * bar with contradictory prices has no price, so the returns that need it are
 * gaps rather than a longer move presented as one interval.
 */
export function buildReturnRows(
  points: readonly PricePoint[],
  visibleFrom = Number.NEGATIVE_INFINITY,
  visibleTo = Number.POSITIVE_INFINITY,
): ReturnRow[] {
  const bars = toBars(points);
  const first = bars.findIndex((bar) => bar.timestamp > visibleFrom);
  if (first < 0) return [];
  const prior = first > 0 ? bars[first - 1]!.close : null;
  const base = prior ?? bars.slice(first).find((bar) => bar.close !== null)?.close ?? null;
  const rows: ReturnRow[] = [];
  for (let index = first; index < bars.length; index += 1) {
    const bar = bars[index]!;
    if (bar.timestamp > visibleTo) break;
    const previous = index > 0 ? bars[index - 1]!.close : null;
    const interval = change(bar.close, previous);
    const cumulative = change(bar.close, base);
    rows.push({
      key: String(bar.timestamp),
      timestamp: bar.timestamp,
      price: bar.close,
      intervalChange: interval.change,
      intervalPercent: interval.percent,
      cumulativeChange: cumulative.change,
      cumulativePercent: cumulative.percent,
      inconsistent: bar.inconsistent,
    });
  }
  return rows.reverse();
}

/** The latest bar time in a loaded history, or null when it has none. */
export function latestBarTime(points: readonly PricePoint[]): number | null {
  let latest: number | null = null;
  for (const point of points) {
    const timestamp = pointTime(point);
    if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}
