import type { PricePoint, Quote } from "../types/financials";

export interface PriceReturnHorizon {
  id: string;
  label: string;
  amount: number;
  unit: "month" | "year";
}

export interface PriceReturnField {
  id: string;
  label: string;
  value: number | null;
}

export const PRICE_RETURN_HORIZONS: PriceReturnHorizon[] = [
  { id: "1M", label: "1M", amount: 1, unit: "month" },
  { id: "3M", label: "3M", amount: 3, unit: "month" },
  { id: "6M", label: "6M", amount: 6, unit: "month" },
  { id: "1Y", label: "1Y", amount: 1, unit: "year" },
  { id: "3Y", label: "3Y", amount: 3, unit: "year" },
  { id: "5Y", label: "5Y", amount: 5, unit: "year" },
];

function coercePointDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizePriceReturnHistory(points: readonly PricePoint[]): PricePoint[] {
  const byTimestamp = new Map<number, PricePoint>();
  for (const point of points) {
    const date = coercePointDate(point.date as Date | string | number);
    if (!date || !Number.isFinite(point.close)) continue;
    byTimestamp.set(date.getTime(), { ...point, date });
  }
  return [...byTimestamp.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, point]) => point);
}

export function appendQuoteToPriceReturnHistory(
  points: readonly PricePoint[],
  quote: Pick<Quote, "price" | "lastUpdated"> | null | undefined,
): PricePoint[] {
  const history = normalizePriceReturnHistory(points);
  if (!quote || !Number.isFinite(quote.price) || !Number.isFinite(quote.lastUpdated)) {
    return history;
  }

  const quoteDate = new Date(quote.lastUpdated);
  if (!Number.isFinite(quoteDate.getTime())) return history;

  const latestHistoryTime = history.at(-1)?.date.getTime() ?? Number.NEGATIVE_INFINITY;
  if (quoteDate.getTime() <= latestHistoryTime) return history;

  return [
    ...history,
    {
      date: quoteDate,
      close: quote.price,
    },
  ];
}

function subtractHorizon(date: Date, horizon: PriceReturnHorizon): Date {
  const target = new Date(date);
  if (horizon.unit === "month") {
    target.setMonth(target.getMonth() - horizon.amount);
  } else {
    target.setFullYear(target.getFullYear() - horizon.amount);
  }
  return target;
}

export function computePriceReturnForHorizon(
  points: readonly PricePoint[],
  horizon: PriceReturnHorizon,
): number | null {
  const history = normalizePriceReturnHistory(points);
  if (history.length < 2) return null;

  const latest = history.at(-1)!;
  const cutoff = subtractHorizon(latest.date, horizon);
  let baseline: PricePoint | null = null;

  for (const point of history) {
    if (point.date.getTime() <= cutoff.getTime()) {
      baseline = point;
    } else {
      break;
    }
  }

  if (!baseline || !Number.isFinite(baseline.close) || baseline.close === 0) return null;
  if (!Number.isFinite(latest.close)) return null;
  return (latest.close - baseline.close) / baseline.close;
}

export function buildPriceReturnFields(
  points: readonly PricePoint[],
  horizons: readonly PriceReturnHorizon[] = PRICE_RETURN_HORIZONS,
): PriceReturnField[] {
  return horizons.map((horizon) => ({
    id: horizon.id,
    label: horizon.label,
    value: computePriceReturnForHorizon(points, horizon),
  }));
}
