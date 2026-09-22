import type { PricePoint, TickerFinancials } from "../types/financials";
import { canonicalExchange, resolveExchangeTimeZone } from "./exchanges";
import { isTimestampStaleForExchangeSession } from "../market-data/market/freshness";
import { regularHistorySessionStaleness } from "../market-data/history-session";
import type { HistorySession } from "../types/price-history";

const MAX_CURRENT_INTRADAY_HISTORY_LAG_MS = 18 * 60 * 60 * 1000;
const MAX_SAME_SESSION_HISTORY_LAG_MS = 30 * 60 * 1000;
const DELAYED_HISTORY_ALLOWANCE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PriceHistoryFreshnessOptions {
  exchange?: string;
  intervalMs?: number | null;
  session?: HistorySession;
}

export function priceHistoryIntervalMs(interval: string): number | null {
  const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)$/i.exec(interval.trim());
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const step = /^(mo|month)/.test(unit) ? 30 * DAY_MS
    : /^(w|wk|week)/.test(unit) ? 7 * DAY_MS
    : /^(d|day)/.test(unit) ? DAY_MS
    : /^(h|hr|hour)/.test(unit) ? 60 * 60 * 1000
    : 60 * 1000;
  return count > 0 && Number.isFinite(count * step) ? count * step : null;
}

function inferredHistoryIntervalMs(points: PricePoint[]): number | null {
  const times = [...new Set(points.slice(-20).map(getPricePointTimestamp))];
  const gaps = times.slice(1).map((time, index) => time - times[index]!);
  const shortest = Math.min(...gaps);
  if (shortest > 0 && shortest <= 60 * 60 * 1000) return shortest;
  // A generic range does not specify bar size. Multiple daily labels can
  // establish daily cadence; a single overnight gap between sparse intraday
  // observations cannot. One-hour drift allows daily exchange opens over DST.
  if (times.length >= 3 && shortest >= 20 * 60 * 60 * 1000) {
    const clockTimes = times.map((time) => time % DAY_MS);
    if (Math.max(...clockTimes) - Math.min(...clockTimes) <= 60 * 60 * 1000) return DAY_MS;
  }
  return null;
}

// Cached history carries ISO strings for dates, and every pass over a
// series (normalizing, sorting, charting) parses each one again; a sort
// comparator does it twice per comparison. Points are never edited in
// place, so the parse is kept per point.
const pointTimestamps = new WeakMap<PricePoint, number>();

export function getPricePointTimestamp(point: PricePoint): number {
  const value = point.date as Date | string | number | null | undefined;
  if (value instanceof Date) return value.getTime();
  if (value == null) return Number.NaN;
  const cached = pointTimestamps.get(point);
  if (cached !== undefined) return cached;
  const time = new Date(value).getTime();
  pointTimestamps.set(point, time);
  return time;
}

function hasFiniteClose(point: PricePoint): boolean {
  return Number.isFinite(point.close);
}

/** Observation dates and usable price coverage are independent. */
export function hasUsablePriceHistory(points: readonly PricePoint[]): boolean {
  return points.some((point) => Number.isFinite(getPricePointTimestamp(point)) && hasFiniteClose(point));
}

/** A usable alternate source may recover a gap; uncovered reported dates remain gaps. */
export function preservePriceHistoryGaps(points: PricePoint[], unavailable: readonly PricePoint[][]): PricePoint[] {
  const times = new Set(points.map(getPricePointTimestamp));
  const gaps: PricePoint[] = [];
  for (const history of unavailable) {
    for (const point of history) {
      const time = getPricePointTimestamp(point);
      if (!Number.isFinite(time) || hasFiniteClose(point) || times.has(time)) continue;
      times.add(time);
      gaps.push(point);
    }
  }
  return gaps.length ? normalizePriceHistory([...points, ...gaps]) : points;
}

function comparePricePointsByDate(left: PricePoint, right: PricePoint): number {
  const leftTime = getPricePointTimestamp(left);
  const rightTime = getPricePointTimestamp(right);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);

  if (leftValid && rightValid) return leftTime - rightTime;
  if (leftValid) return -1;
  if (rightValid) return 1;
  return 0;
}

// The merged financials view is rebuilt on every quote tick and normalizes
// the same history array each time. Arrays are replaced, not edited, so the
// result is kept per input array.
const normalizedHistories = new WeakMap<PricePoint[], PricePoint[]>();

export function normalizePriceHistory(points: PricePoint[]): PricePoint[] {
  if (points.length === 0) return points;
  const cached = normalizedHistories.get(points);
  if (cached) return cached;
  const normalized = normalizePriceHistoryUncached(points);
  normalizedHistories.set(points, normalized);
  return normalized;
}

function normalizePriceHistoryUncached(points: PricePoint[]): PricePoint[] {
  const validPoints: PricePoint[] = [];
  let sawDistinctTimestamp = false;
  let firstTimestamp: number | null = null;
  let previousTime = Number.NEGATIVE_INFINITY;
  let requiresSort = false;

  for (const point of points) {
    const time = getPricePointTimestamp(point);
    if (!Number.isFinite(time)) continue;
    // Keep dated unavailable closes so downstream returns/charts cannot join
    // their neighbors, including when the entire response is unavailable.

    if (firstTimestamp === null) {
      firstTimestamp = time;
    } else if (time !== firstTimestamp) {
      sawDistinctTimestamp = true;
    }

    if (time < previousTime) {
      requiresSort = true;
    }
    previousTime = time;
    validPoints.push(point);
  }

  if (validPoints.length === 0) return [];
  if (validPoints.length === 1) return validPoints;
  if (!sawDistinctTimestamp) return [];

  if (requiresSort) {
    return [...validPoints].sort(comparePricePointsByDate);
  }
  return validPoints.length === points.length ? points : validPoints;
}

export function isPriceHistoryStaleForCurrentWindow(
  points: PricePoint[],
  now = Date.now(),
  options: PriceHistoryFreshnessOptions = {},
): boolean {
  const normalized = normalizePriceHistory(points);
  const latest = normalized.findLast(hasFiniteClose);
  if (!latest) return false;

  const session = options.session?.exchange === canonicalExchange(options.exchange)
    ? options.session : undefined;
  const sessionInterval = session ? priceHistoryIntervalMs(session.interval) : null;
  const intervalMs = options.intervalMs ?? sessionInterval ?? inferredHistoryIntervalMs(normalized);
  // Daily/weekly/monthly labels are period starts, not live observation times.
  // Their cache policy controls refresh; an intraday lag test is inapplicable.
  if (intervalMs != null && intervalMs >= DAY_MS) return false;

  const latestTime = getPricePointTimestamp(latest);
  if (!Number.isFinite(latestTime)) return false;
  if (session && (options.intervalMs == null || options.intervalMs === sessionInterval)) {
    const regularStale = regularHistorySessionStaleness(latestTime, now, session);
    if (regularStale !== null) return regularStale;
  }
  const age = now - latestTime;
  // Completed bars are timestamped at their opening time. Before the next
  // completed bar is delivered, the newest bar may be almost two intervals
  // plus the feed delay old. Keep the existing tolerance for finer bars.
  const allowedLag = Math.max(MAX_SAME_SESSION_HISTORY_LAG_MS,
    intervalMs != null ? 2 * intervalMs + DELAYED_HISTORY_ALLOWANCE_MS : 0);
  if (age <= allowedLag) return false;
  const exchange = options.exchange || "NASDAQ";
  if (
    resolveExchangeTimeZone(exchange)
    && isTimestampStaleForExchangeSession(latestTime, exchange, now)
  ) {
    return true;
  }
  const hasExchangeSession = Boolean(resolveExchangeTimeZone(exchange));
  if (age <= MAX_CURRENT_INTRADAY_HISTORY_LAG_MS) return hasExchangeSession;
  return !hasExchangeSession;
}

export function normalizeTickerFinancialsPriceHistory(financials: TickerFinancials): TickerFinancials {
  const priceHistory = normalizePriceHistory(financials.priceHistory ?? []);
  return priceHistory === financials.priceHistory
    ? financials
    : { ...financials, priceHistory };
}
