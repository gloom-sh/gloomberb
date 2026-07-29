import type { PricePoint } from "../../../types/financials";
import { getPricePointTimestamp } from "../../../utils/price-history";

export interface DatedReturn {
  dateKey: string;
  value: number;
}

export interface CorrelationResult {
  correlation: number | null;
  sampleSize: number;
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

export function computeDatedReturns(points: PricePoint[]): DatedReturn[] {
  const sorted = [...points]
    .filter((point) => Number.isFinite(getPricePointTimestamp(point)) && Number.isFinite(point.close))
    .sort(comparePricePointsByDate);
  const byDate = new Map<string, number>();

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (previous.close === 0) continue;
    const value = (current.close - previous.close) / previous.close;
    const dateKey = toDateKey(current);
    if (!dateKey || !Number.isFinite(value)) continue;
    byDate.set(dateKey, value);
  }

  return [...byDate.entries()].map(([dateKey, value]) => ({ dateKey, value }));
}

export function alignDatedReturns(x: DatedReturn[], y: DatedReturn[]): { x: number[]; y: number[]; sampleSize: number } {
  const yByDate = new Map(y.map((entry) => [entry.dateKey, entry.value] as const));
  const alignedX: number[] = [];
  const alignedY: number[] = [];

  for (const left of x) {
    const rightValue = yByDate.get(left.dateKey);
    if (rightValue === undefined) continue;
    alignedX.push(left.value);
    alignedY.push(rightValue);
  }

  return {
    x: alignedX,
    y: alignedY,
    sampleSize: alignedX.length,
  };
}

export function pearsonCorrelation(x: number[], y: number[], minObservations = 5): number | null {
  const n = Math.min(x.length, y.length);
  if (n < minObservations) return null;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]!;
    sumY += y[i]!;
    sumXY += x[i]! * y[i]!;
    sumX2 += x[i]! * x[i]!;
    sumY2 += y[i]! * y[i]!;
  }

  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

export function correlateDatedReturns(x: DatedReturn[], y: DatedReturn[], minObservations = 5): CorrelationResult {
  const aligned = alignDatedReturns(x, y);
  return {
    correlation: pearsonCorrelation(aligned.x, aligned.y, minObservations),
    sampleSize: aligned.sampleSize,
  };
}

export function formatCorrelation(r: number | null): string {
  if (r === null) return "  —  ";
  return r >= 0 ? ` ${r.toFixed(2)}` : r.toFixed(2);
}
