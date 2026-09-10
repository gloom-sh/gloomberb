import type { PricePoint } from "../../../types/financials";
import { getPricePointTimestamp } from "../../../utils/price-history";

export interface CorrelationResult {
  correlation: number | null;
  sampleSize: number;
}

export interface DailyClose {
  dateKey: string;
  close: number;
}

/** Keep the final valid close for each UTC trading date, in chronological order. */
export function dailyCloses(points: readonly PricePoint[]): DailyClose[] {
  const byDate = new Map<string, number>();
  for (const point of [...points].sort(comparePricePointsByDate)) {
    const dateKey = toDateKey(point);
    if (!dateKey || !Number.isFinite(point.close) || point.close <= 0) continue;
    byDate.set(dateKey, point.close);
  }
  return [...byDate].map(([dateKey, close]) => ({ dateKey, close }));
}

export interface AlignedDailyClose {
  dateKey: string;
  leftClose: number;
  rightClose: number;
}

/**
 * Align prices before computing returns. Aligning return end dates alone pairs
 * a stock's Friday-to-Monday move with crypto's Sunday-to-Monday move, and does
 * the same across different exchange holidays or missing observations.
 */
export function alignDailyCloses(left: readonly DailyClose[], right: readonly DailyClose[]): AlignedDailyClose[] {
  const rightByDate = new Map(right.map((point) => [point.dateKey, point.close]));
  return left.flatMap((point) => {
    const rightClose = rightByDate.get(point.dateKey);
    return rightClose === undefined ? [] : [{ dateKey: point.dateKey, leftClose: point.close, rightClose }];
  });
}

export function correlateDailyCloses(left: readonly DailyClose[], right: readonly DailyClose[], minObservations = 5): CorrelationResult {
  const aligned = alignDailyCloses(left, right);
  const x = computeReturns(aligned.map((point) => point.leftClose));
  const y = computeReturns(aligned.map((point) => point.rightClose));
  return { correlation: pearsonCorrelation(x, y, minObservations), sampleSize: x.length };
}

function toDateKey(point: PricePoint): string | null {
  const timestamp = getPricePointTimestamp(point);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function comparePricePointsByDate(left: PricePoint, right: PricePoint): number {
  return getPricePointTimestamp(left) - getPricePointTimestamp(right);
}

export function computeReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const previous = closes[i - 1]!;
    const current = closes[i]!;
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) continue;
    returns.push((current - previous) / previous);
  }
  return returns;
}

export function pearsonCorrelation(x: number[], y: number[], minObservations = 5): number | null {
  const n = Math.min(x.length, y.length);
  if (n < minObservations) return null;

  if (!x.slice(0, n).every(Number.isFinite) || !y.slice(0, n).every(Number.isFinite)) return null;
  const meanX = x.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const meanY = y.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0, varianceX = 0, varianceY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  const denom = Math.sqrt(varianceX * varianceY);
  if (!Number.isFinite(denom) || denom === 0) return null;
  return Math.max(-1, Math.min(1, covariance / denom));
}

export function formatCorrelation(r: number | null): string {
  if (r === null) return "  —  ";
  return r >= 0 ? ` ${r.toFixed(2)}` : r.toFixed(2);
}
