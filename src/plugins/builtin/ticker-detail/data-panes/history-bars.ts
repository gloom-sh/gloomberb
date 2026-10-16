import { BAR_INTERVAL_LABELS } from "../../../../cli/history-rows";
import { periodToDateText } from "../../../../cli/pane-functions/freshness";
import { barPeriodToDate, type BarPeriod, type BarPeriodToDate } from "../../../../market-data/market/bar-period";
import { barSizeFromGap, medianBarGap } from "../../../../time-series/bar-spacing";
import type { TimeRange } from "../../../../time-series/range";
import { CHART_RESOLUTION_STEP_MS, type ManualChartResolution } from "../../../../time-series/resolution";

/**
 * The range a price history opens on, in Historical Prices, `fn HP` and
 * `shot HP`: a recent window in daily bars (RANGE_HISTORY_RESOLUTION serves
 * 1M to 1Y daily). 5Y is weekly and ALL monthly, so neither is a place to start.
 */
export const HISTORY_DEFAULT_RANGE: TimeRange = "3M";

/** The size of one bar of a price history; `intraday` when its minutes are not a size the source serves. */
export type HistoryBarSize = ManualChartResolution | "intraday";

const INTRADAY_SIZES: readonly ManualChartResolution[] = ["1m", "5m", "15m", "30m", "45m", "1h"];
/** A day's bars can sit a little under a day apart where the clocks change. */
const INTRADAY_BELOW_MS = 0.8 * CHART_RESOLUTION_STEP_MS["1d"];

/**
 * The bar size of a history, read from the usual spacing of its bars
 * (medianBarGap), as `history` reads it, so the gap a holiday leaves does not
 * make daily bars weekly. Daily when there is no gap to read.
 */
export function historyBarSize(times: readonly number[]): HistoryBarSize {
  const gap = medianBarGap(times);
  if (gap == null) return "1d";
  if (gap < INTRADAY_BELOW_MS) return INTRADAY_SIZES.find((size) => CHART_RESOLUTION_STEP_MS[size] === gap) ?? "intraday";
  return barSizeFromGap(gap);
}

/** Whether a bar of this size covers a day or more, so its date is a day and not a time. */
export function isDailyOrLongerBar(size: HistoryBarSize): size is "1d" | "1wk" | "1mo" {
  return size === "1d" || size === "1wk" || size === "1mo";
}

/** `daily`, `5-minute`, `hourly`, `weekly`, `monthly`; `intraday` when the minutes are not a known size. */
export function historyBarSizeWord(size: HistoryBarSize): string {
  return size === "intraday" ? size : BAR_INTERVAL_LABELS[size];
}

/** `daily bars`, `monthly bars`: what a history says its bars are, which the range it was asked for sets. */
export function historyBarSizeText(size: HistoryBarSize): string {
  return `${historyBarSizeWord(size)} bars`;
}

/**
 * What a date column heads when its bars cover more than a day: `Week of`
 * (each is dated by the day its week starts) or `Month`. Null for a day's bar,
 * whose column is `Date`, or an intraday one, which is dated with a time.
 */
export function historyDateHeader(size: HistoryBarSize): string | null {
  return size === "1wk" ? "Week of" : size === "1mo" ? "Month" : null;
}

/** The calendar period a weekly or monthly bar covers; null for any other. */
function historyBarPeriod(size: HistoryBarSize): BarPeriod | null {
  return size === "1mo" ? "month" : size === "1wk" ? "week" : null;
}

/**
 * Whether the newest bar, dated `date`, is a week or month that had not ended
 * at `now` on its `venue` (barPeriodToDate), and how far into it the bar runs.
 * Null for a complete bar, and for any bar that is not weekly or monthly.
 */
export function formingHistoryBar(
  size: HistoryBarSize,
  date: string | undefined,
  venue: string | undefined,
  now: number,
): BarPeriodToDate | null {
  const period = historyBarPeriod(size);
  return period && date ? barPeriodToDate(date, period, venue, now) : null;
}

/**
 * A bar's day as its table dates it: a month's bar as the month (`2026-10`),
 * a week's by the day it starts, and `MTD`, `WTD` or `DTD` after one whose
 * period had not ended, so it never reads as a complete bar dated on its
 * first day. `day` is `YYYY-MM-DD`.
 */
export function historyBarDate(day: string, size: HistoryBarSize, partial = false): string {
  const text = size === "1mo" ? day.slice(0, 7) : day;
  return partial ? `${text} ${size === "1mo" ? "MTD" : size === "1wk" ? "WTD" : "DTD"}` : text;
}

/** What the newest bar covers so far: `month to date, through Fri 16 Oct 2026`. */
export function formingHistoryBarText(forming: BarPeriodToDate, date: string): string {
  return periodToDateText({ period: forming.period, ...(forming.through ? { through: forming.through } : {}) }, date);
}
