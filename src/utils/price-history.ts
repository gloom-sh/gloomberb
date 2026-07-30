import type { PricePoint, TickerFinancials } from "../types/financials";
import { resolveExchangeTimeZone } from "./exchanges";
import { isTimestampStaleForExchangeSession } from "../market-data/market/freshness";

const MAX_CURRENT_INTRADAY_HISTORY_LAG_MS = 18 * 60 * 60 * 1000;
const MAX_OUTLIER_NEIGHBOR_GAP_MS = 60 * 60 * 1000;
const STABLE_NEIGHBOR_CLOSE_RATIO = 0.02;
const ZERO_VOLUME_OHLC_OUTLIER_RATIO = 0.04;

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

function relativeDifference(value: number, reference: number): number {
  return Math.abs(value - reference) / reference;
}

function repairZeroVolumeOhlcOutlier(
  previous: PricePoint,
  point: PricePoint,
  next: PricePoint,
): PricePoint {
  if (point.volume !== 0) return point;

  const previousGap = getPricePointTimestamp(point) - getPricePointTimestamp(previous);
  const nextGap = getPricePointTimestamp(next) - getPricePointTimestamp(point);
  if (
    previousGap <= 0
    || nextGap <= 0
    || previousGap > MAX_OUTLIER_NEIGHBOR_GAP_MS
    || nextGap > MAX_OUTLIER_NEIGHBOR_GAP_MS
    || relativeDifference(previous.close, point.close) > STABLE_NEIGHBOR_CLOSE_RATIO
    || relativeDifference(next.close, point.close) > STABLE_NEIGHBOR_CLOSE_RATIO
  ) {
    return point;
  }

  const isOutlier = (value: number | undefined) => (
    typeof value === "number"
    && Number.isFinite(value)
    && relativeDifference(value, point.close) > ZERO_VOLUME_OHLC_OUTLIER_RATIO
  );
  const repairOpen = isOutlier(point.open);
  const repairHigh = isOutlier(point.high);
  const repairLow = isOutlier(point.low);
  if (!repairOpen && !repairHigh && !repairLow) return point;

  const open = repairOpen ? previous.close : point.open;
  const bodyHigh = Math.max(point.close, open ?? point.close);
  const bodyLow = Math.min(point.close, open ?? point.close);
  return {
    ...point,
    open,
    high: repairHigh ? bodyHigh : point.high,
    low: repairLow ? bodyLow : point.low,
  };
}

function repairZeroVolumeOhlcOutliers(points: PricePoint[]): PricePoint[] {
  let repaired: PricePoint[] | null = null;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const next = repairZeroVolumeOhlcOutlier(points[index - 1]!, point, points[index + 1]!);
    if (next === point) continue;
    repaired ??= [...points];
    repaired[index] = next;
  }
  return repaired ?? points;
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

  const orderedPoints = requiresSort
    ? [...validPoints].sort(comparePricePointsByDate)
    : validPoints;
  const repairedPoints = repairZeroVolumeOhlcOutliers(orderedPoints);
  if (repairedPoints !== orderedPoints) return repairedPoints;
  if (requiresSort) return orderedPoints;
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
