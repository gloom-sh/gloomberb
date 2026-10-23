import type { PricePoint, Quote } from "../types/financials";
import { pricePointIntegrity } from "../utils/price-history-integrity";
import { calendarMonthsBefore } from "../utils/calendar-date";
import { barSessionDay, isReturnPeriod, periodBaseDay, periodBaseIndex } from "./market/period-return";

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
  unavailableReason?: "inconsistent-ohlc";
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
    if (!date || (!Number.isFinite(point.close) && !pricePointIntegrity(point))) continue;
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

/** The calendar date a horizon ending on `day` is measured back to (periodBaseDay). */
function horizonBaseDay(day: string, horizon: PriceReturnHorizon): string {
  return isReturnPeriod(horizon.id)
    ? periodBaseDay(day, horizon.id)
    : calendarMonthsBefore(new Date(`${day}T00:00:00Z`), horizon.amount * (horizon.unit === "year" ? 12 : 1)).toISOString().slice(0, 10);
}

/** `venue` is the listing's exchange, whose clock dates its bars and quote (barSessionDay). */
export function computePriceReturnForHorizon(
  points: readonly PricePoint[],
  horizon: PriceReturnHorizon,
  venue?: string,
): number | null {
  return priceReturnForHorizon(points, horizon, venue).value;
}

function priceReturnForHorizon(
  points: readonly PricePoint[],
  horizon: PriceReturnHorizon,
  venue: string | undefined,
): Pick<PriceReturnField, "value" | "unavailableReason"> {
  const history = normalizePriceReturnHistory(points);
  if (history.length < 2) return {
    value: null,
    ...(history.some(pricePointIntegrity) ? { unavailableReason: "inconsistent-ohlc" as const } : {}),
  };

  const latest = history.at(-1)!;
  // The close on or before the same date a horizon earlier, as every period return is measured. No gap
  // limit: the overview's history can be sparse, and its base is whatever close it holds on or before then.
  // Each bar and the quote by its session day: a JPX bar stamped 00:00 JST, or a quote after a New York close, is not the UTC date's.
  const days = history.map((point) => barSessionDay(point.date.getTime(), venue));
  const baseDay = horizonBaseDay(days.at(-1)!, horizon);
  const baseIndex = periodBaseIndex(days, baseDay, Number.POSITIVE_INFINITY);
  const baseline = baseIndex < 0 ? null : history[baseIndex]!;
  const cutoff = new Date(`${baseDay}T00:00:00Z`);

  if (history.some((point) => point.date >= (baseline?.date ?? cutoff) && pricePointIntegrity(point))) {
    return { value: null, unavailableReason: "inconsistent-ohlc" };
  }
  if (!baseline || !Number.isFinite(baseline.close) || baseline.close === 0) return { value: null };
  if (!Number.isFinite(latest.close)) return { value: null };
  return { value: (latest.close - baseline.close) / baseline.close };
}

export function buildPriceReturnFields(
  points: readonly PricePoint[],
  venue?: string,
  horizons: readonly PriceReturnHorizon[] = PRICE_RETURN_HORIZONS,
): PriceReturnField[] {
  return horizons.map((horizon) => ({
    id: horizon.id,
    label: horizon.label,
    ...priceReturnForHorizon(points, horizon, venue),
  }));
}
