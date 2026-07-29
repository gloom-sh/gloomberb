import type { PricePoint, TickerFinancials } from "../types/financials";
import { resolveExchangeTimeZone } from "./exchanges";
import { isTimestampStaleForExchangeSession } from "../market-data/market/freshness";

const MAX_CURRENT_INTRADAY_HISTORY_LAG_MS = 18 * 60 * 60 * 1000;

interface PriceHistoryFreshnessOptions {
  exchange?: string;
}

export function getPricePointTimestamp(point: PricePoint): number {
  const value = point.date as Date | string | number | null | undefined;
  if (value instanceof Date) return value.getTime();
  if (value == null) return Number.NaN;
  return new Date(value).getTime();
}

function hasValidClose(point: PricePoint): boolean {
  return Number.isFinite(point.close) && point.close > 0;
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

export function normalizePriceHistory(points: PricePoint[]): PricePoint[] {
  if (points.length === 0) return points;

  const validPoints: PricePoint[] = [];
  let sawDistinctTimestamp = false;
  let firstTimestamp: number | null = null;
  let previousTime = Number.NEGATIVE_INFINITY;
  let requiresSort = false;

  for (const point of points) {
    const time = getPricePointTimestamp(point);
    if (!Number.isFinite(time)) continue;
    if (!hasValidClose(point)) continue;

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
  const latest = normalized.at(-1);
  if (!latest) return false;

  const latestTime = getPricePointTimestamp(latest);
  if (!Number.isFinite(latestTime) || now - latestTime <= MAX_CURRENT_INTRADAY_HISTORY_LAG_MS) {
    return false;
  }

  if (
    options.exchange
    && resolveExchangeTimeZone(options.exchange)
    && !isTimestampStaleForExchangeSession(latestTime, options.exchange, now)
  ) {
    return false;
  }

  return true;
}

export function normalizeTickerFinancialsPriceHistory(financials: TickerFinancials): TickerFinancials {
  const priceHistory = normalizePriceHistory(financials.priceHistory ?? []);
  return priceHistory === financials.priceHistory
    ? financials
    : { ...financials, priceHistory };
}
