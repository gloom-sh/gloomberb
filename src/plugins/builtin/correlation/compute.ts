import type { PricePoint } from "../../../types/financials";
import { getPricePointTimestamp } from "../../../utils/price-history";

export interface CorrelationResult {
  correlation: number | null;
  sampleSize: number;
}

export interface DailyClose {
  dateKey: string;
  /** A closing price, or a map series' value for the day (a transit count). */
  close: number;
}

/**
 * How a series moves between two shared dates. Prices use returns. A map
 * series is a daily count that can be zero (Hormuz logs days with no
 * transits), where a return or log change is undefined, so it uses the
 * change in level. Pearson correlation ignores the unit, so the level change
 * needs no scaling.
 */
export type ChangeBasis = "return" | "difference";

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

/** A map series' daily values, oldest first; zero is a value, unlike a zero close. */
export function dailyValues(points: readonly { date: Date; value: number | null }[]): DailyClose[] {
  const byDate = new Map<string, number>();
  for (const point of [...points].sort((left, right) => left.date.getTime() - right.date.getTime())) {
    if (point.value === null || !Number.isFinite(point.value) || !Number.isFinite(point.date.getTime())) continue;
    byDate.set(point.date.toISOString().slice(0, 10), point.value);
  }
  return [...byDate].map(([dateKey, close]) => ({ dateKey, close }));
}

export interface PairedChange {
  dateKey: string;
  left: number;
  right: number;
}

function change(previous: number, current: number, basis: ChangeBasis): number {
  return basis === "difference" ? current - previous : previous > 0 ? (current - previous) / previous : Number.NaN;
}

/** Each side's move between consecutive shared dates, dropped for both sides when either is undefined. */
export function pairedChanges(
  aligned: readonly AlignedDailyClose[],
  leftBasis: ChangeBasis = "return",
  rightBasis: ChangeBasis = "return",
): PairedChange[] {
  const changes: PairedChange[] = [];
  for (let index = 1; index < aligned.length; index++) {
    const previous = aligned[index - 1]!;
    const current = aligned[index]!;
    const left = change(previous.leftClose, current.leftClose, leftBasis);
    const right = change(previous.rightClose, current.rightClose, rightBasis);
    if (Number.isFinite(left) && Number.isFinite(right)) changes.push({ dateKey: current.dateKey, left, right });
  }
  return changes;
}

export function correlateDailyCloses(
  left: readonly DailyClose[],
  right: readonly DailyClose[],
  minObservations = 5,
  leftBasis: ChangeBasis = "return",
  rightBasis: ChangeBasis = "return",
): CorrelationResult {
  const changes = pairedChanges(alignDailyCloses(left, right), leftBasis, rightBasis);
  return {
    correlation: pearsonCorrelation(changes.map((point) => point.left), changes.map((point) => point.right), minObservations),
    sampleSize: changes.length,
  };
}

function toDateKey(point: PricePoint): string | null {
  const timestamp = getPricePointTimestamp(point);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function comparePricePointsByDate(left: PricePoint, right: PricePoint): number {
  return getPricePointTimestamp(left) - getPricePointTimestamp(right);
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
