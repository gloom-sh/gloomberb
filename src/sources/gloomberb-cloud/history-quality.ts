import type { PricePoint } from "../../types/financials";
import { getPricePointTimestamp } from "../../utils/price-history";

const MAX_NEIGHBOR_GAP_MS = 60 * 60 * 1000;
const STABLE_NEIGHBOR_CLOSE_RATIO = 0.02;
const ISOLATED_OHLC_OUTLIER_RATIO = 0.04;

function relativeDifference(value: number, reference: number): number {
  return Math.abs(value - reference) / reference;
}

function isIsolatedOhlcOutlier(
  previous: PricePoint,
  point: PricePoint,
  next: PricePoint,
): boolean {
  const previousGap = getPricePointTimestamp(point) - getPricePointTimestamp(previous);
  const nextGap = getPricePointTimestamp(next) - getPricePointTimestamp(point);
  if (
    previousGap <= 0
    || nextGap <= 0
    || previousGap > MAX_NEIGHBOR_GAP_MS
    || nextGap > MAX_NEIGHBOR_GAP_MS
    || relativeDifference(previous.close, point.close) > STABLE_NEIGHBOR_CLOSE_RATIO
    || relativeDifference(next.close, point.close) > STABLE_NEIGHBOR_CLOSE_RATIO
  ) {
    return false;
  }

  return [point.open, point.high, point.low].some((value) => (
    typeof value === "number"
    && Number.isFinite(value)
    && relativeDifference(value, point.close) > ISOLATED_OHLC_OUTLIER_RATIO
  ));
}

export function hasMalformedCloudIntradayHistory(points: readonly PricePoint[]): boolean {
  for (let index = 1; index < points.length - 1; index += 1) {
    if (isIsolatedOhlcOutlier(points[index - 1]!, points[index]!, points[index + 1]!)) {
      return true;
    }
  }
  return false;
}
