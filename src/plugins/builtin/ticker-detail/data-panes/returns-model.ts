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
import { isAlwaysOpenExchange, isRegularSessionTime, latestRegularSessionClose, sessionCalendarTimeZone } from "../../../../market-data/market/freshness";
import { barLastSession } from "../../../../market-data/market/bar-period";
import { barCloseDay, isIntradayDailyBar, isReturnPeriod, periodBaseDay } from "../../../../market-data/market/period-return";
import { isRoundTheClockCoin } from "../../../../utils/crypto-pair";
import { currentFxClosureStart, isCurrencyPairListing } from "../../../../utils/fx-market-hours";
import { pricePointValues } from "../../../../utils/price-history-integrity";
import { zonedDateKey } from "../../../../utils/zoned-date-time";

export type ReturnRange = "6H" | "1D" | "5D" | TimeRange;

export const RETURN_RANGES: readonly ReturnRange[] = ["6H", "1D", "5D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"];

/** The bar sizes RETURN takes, as `--interval` reads them. */
export const RETURN_INTERVAL_VALUES: Array<{ value: ManualChartResolution; aliases?: string[] }> = [
  { value: "1m", aliases: ["1min"] },
  { value: "5m", aliases: ["5min"] },
  { value: "15m", aliases: ["15min"] },
  { value: "30m", aliases: ["30min"] },
  { value: "45m", aliases: ["45min"] },
  { value: "1h", aliases: ["60m", "hour", "hourly"] },
  { value: "1d", aliases: ["day", "daily"] },
  { value: "1wk", aliases: ["1w", "week", "weekly"] },
  { value: "1mo", aliases: ["month", "monthly"] },
];

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

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The session date of `time` at a venue, on its clock; the UTC date where its sessions are unknown. */
function venueDay(time: number, venue: string | undefined): string {
  const zone = venue ? sessionCalendarTimeZone(venue) : null;
  return zone ? zonedDateKey(time, zone) : utcDay(time);
}

/**
 * The calendar date a 1W to 5Y window ending at `end` is measured from, the
 * close on or before which is the base of its returns (periodBaseDay), as CMP
 * and every period return measure it: 1M ending Wed 21 Oct is from Mon 21
 * Sep's close. Null for 6H, 1D and 5D, which are spans of time, and ALL.
 */
export function returnBaseDay(range: ReturnRange, end: number, venue?: string): string | null {
  return isReturnPeriod(range) ? periodBaseDay(venueDay(end, venue), range) : null;
}

/**
 * Where the rows after a base day start, exclusive: past the base day's
 * session close for intraday bars, and before the first bar whose close is
 * from after it for daily (stamped by their date at midnight UTC), weekly
 * and monthly ones (stamped by their period's first day, barCloseDay).
 */
function afterBaseDay(baseDay: string, resolution: ManualChartResolution, venue: string | undefined): number {
  const nextDay = Date.parse(`${baseDay}T00:00:00Z`) + DAY_MS;
  if (isIntradayResolution(resolution)) {
    // Midnight UTC after the base day is past every venue's close of it and before its next one.
    const close = venue ? latestRegularSessionClose(venue, nextDay) : null;
    return close && close.date <= baseDay ? close.close - 1 : nextDay - 1;
  }
  for (let day = nextDay - 40 * DAY_MS; day <= nextDay; day += DAY_MS) {
    if (barCloseDay(utcDay(day), resolution, venue) > baseDay) return day - 1;
  }
  return nextDay - 1;
}

/**
 * Where the rows start, exclusive. A 1W to 5Y window starts after its base
 * day (returnBaseDay), so the close on or before it is the bar before the
 * rows and the base of every return. Otherwise the window's start for
 * intraday bars; a daily or longer bar is stamped with its date at midnight
 * UTC, so the window takes every bar from its start date on.
 */
export function returnVisibleFrom(range: ReturnRange, resolution: ManualChartResolution, end: number, venue?: string): number {
  const baseDay = returnBaseDay(range, end, venue);
  if (baseDay) return afterBaseDay(baseDay, resolution, venue);
  const start = returnWindowStart(range, end);
  if (isIntradayResolution(resolution)) return start;
  const day = new Date(start);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime() - 1;
}

/**
 * These windows are shorter than a closed market's gap, so they also end at
 * the latest bar when it is earlier: a venue whose sessions the app does not
 * know (an index, a future) still shows its last session on a weekend.
 */
export function endsAtLatestBar(range: ReturnRange): boolean {
  return range === "6H" || range === "1D";
}

/** Where a return window ends, and why. */
export interface ReturnWindowEnd {
  end: number;
  /** The market is shut: the local date of its last session, whose close the window ends at. */
  lastSession?: string;
}

/**
 * Where a return window ends: now while the market trades, and always for a
 * coin, which trades around the clock. A market shut for the weekend, a
 * holiday or the night ends it at its last session's close, so 5D on a Sunday
 * is Monday to Friday rather than Wednesday to Friday and a gap. Spot FX
 * closes for the weekend at 17:00 New York on Friday. A venue whose hours the
 * app does not know ends now.
 */
export function returnWindowEnd(market: { symbol: string; exchange: string }, now: number): ReturnWindowEnd {
  if (isRoundTheClockCoin(market.symbol, market.exchange) || isAlwaysOpenExchange(market.exchange)) return { end: now };
  if (isCurrencyPairListing(market.symbol, market.exchange)) {
    const closure = currentFxClosureStart(now);
    return closure == null ? { end: now } : { end: closure, lastSession: zonedDateKey(closure - 1, "America/New_York") };
  }
  if (isRegularSessionTime(market.exchange, now) !== false) return { end: now };
  const last = latestRegularSessionClose(market.exchange, now);
  return last ? { end: last.close, lastSession: last.date } : { end: now };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `market closed, last session Fri 9 Oct`; the year only when it is not the current one. */
export function closedMarketNote(lastSession: string, now: number): string {
  const day = new Date(`${lastSession}T00:00:00Z`);
  if (!Number.isFinite(day.getTime())) return "market closed";
  const year = day.getUTCFullYear() === new Date(now).getUTCFullYear() ? "" : ` ${day.getUTCFullYear()}`;
  return `market closed, last session ${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}${year}`;
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

/**
 * The session day of the close every return of a window is measured from
 * (buildReturnRows' base): the bar before its rows, else its first priced
 * bar. A daily bar's date, a weekly or monthly bar's last session, an
 * intraday bar's session date at its venue. Null for a window without rows.
 */
export function returnBaseCloseDay(
  points: readonly PricePoint[],
  visibleFrom: number,
  resolution: ManualChartResolution,
  venue: string | undefined,
  now: number,
): string | null {
  const bars = toBars(points);
  const first = bars.findIndex((bar) => bar.timestamp > visibleFrom);
  if (first < 0) return null;
  const base = first > 0 && bars[first - 1]!.close !== null ? bars[first - 1] : bars.slice(first).find((bar) => bar.close !== null);
  if (!base) return null;
  if (isIntradayResolution(resolution)) return venueDay(base.timestamp, venue);
  const day = utcDay(base.timestamp);
  const period = resolution === "1wk" ? "week" : resolution === "1mo" ? "month" : null;
  return period ? barLastSession(day, period, venue, now) ?? barCloseDay(day, resolution, venue) : day;
}

/** Whether the newest daily row is the session still trading at its venue, which its table marks. */
export function isTodayReturnRow(row: Pick<ReturnRow, "timestamp"> | undefined, resolution: ManualChartResolution, venue: string | undefined, now: number): boolean {
  return !!row && resolution === "1d" && isIntradayDailyBar(utcDay(row.timestamp), venue, now);
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
