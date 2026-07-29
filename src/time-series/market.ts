import type { PricePoint, TickerFinancials } from "../types/financials";
import { canonicalTimeSeriesFieldId, isFundamentalFieldId, isMarketFieldId } from "./field-catalog";
import { extractFundamentalSeries } from "./fundamentals";
import type { SecuritySeriesSource, SeriesPeriod, TimeSeriesPoint } from "./types";

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pricePointDate(value: unknown): Date | null {
  const date = value instanceof Date ? new Date(value) : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date : null;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function periodKey(date: Date, period: SeriesPeriod): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (period === "annual") return String(year);
  if (period === "quarterly") return `${year}-Q${Math.floor(month / 3) + 1}`;
  if (period === "monthly") return `${year}-${String(month + 1).padStart(2, "0")}`;
  if (period === "weekly") {
    const monday = new Date(Date.UTC(year, month, date.getUTCDate()));
    const weekday = monday.getUTCDay();
    monday.setUTCDate(monday.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
    return utcDay(monday);
  }
  return utcDay(date);
}

interface AggregatedPricePoint {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Aggregates OHLCV correctly: first open, max high, min low, last close, summed volume. */
function aggregatePriceHistory(
  points: readonly PricePoint[],
  period: SeriesPeriod,
): PricePoint[] {
  const sorted = points
    .flatMap((point) => {
      const date = pricePointDate(point.date);
      return date && finiteNumber(point.close) ? [{ ...point, date }] : [];
    })
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  if (period === "auto") return sorted.map((point) => ({ ...point, date: new Date(point.date) }));
  if (period === "ttm") return [];

  const buckets = new Map<string, AggregatedPricePoint>();
  for (const point of sorted) {
    const key = periodKey(point.date, period);
    const open = finiteNumber(point.open) ? point.open : point.close;
    const high = finiteNumber(point.high) ? point.high : point.close;
    const low = finiteNumber(point.low) ? point.low : point.close;
    const current = buckets.get(key);
    if (!current) {
      buckets.set(key, {
        date: new Date(point.date),
        open,
        high,
        low,
        close: point.close,
        volume: finiteNumber(point.volume) ? point.volume : undefined,
      });
      continue;
    }
    current.date = new Date(point.date);
    current.high = Math.max(current.high, high);
    current.low = Math.min(current.low, low);
    current.close = point.close;
    if (finiteNumber(point.volume)) current.volume = (current.volume ?? 0) + point.volume;
  }
  return [...buckets.values()];
}

export function extractPriceSeries(
  priceHistory: readonly PricePoint[],
  source: SecuritySeriesSource,
): TimeSeriesPoint[] {
  const fieldId = canonicalTimeSeriesFieldId(source.fieldId);
  if (!isMarketFieldId(fieldId)) return [];
  const aggregated = aggregatePriceHistory(priceHistory, source.period ?? "auto");
  return aggregated.map((point) => {
    const value = fieldId === "market.open"
      ? point.open
      : fieldId === "market.high"
        ? point.high
        : fieldId === "market.low"
          ? point.low
          : fieldId === "market.volume"
            ? point.volume
            : point.close;
    return {
      date: new Date(point.date),
      observedAt: new Date(point.date),
      availableAt: new Date(point.date),
      value: finiteNumber(value) ? value : null,
      open: finiteNumber(point.open) ? point.open : null,
      high: finiteNumber(point.high) ? point.high : null,
      low: finiteNumber(point.low) ? point.low : null,
      close: finiteNumber(point.close) ? point.close : null,
      volume: finiteNumber(point.volume) ? point.volume : null,
      provenance: { quality: "reported" as const },
    };
  });
}

/** Pure security-source coordinator used by runtime hooks after data loading. */
export function extractSecuritySeries(
  financials: TickerFinancials | null,
  source: SecuritySeriesSource,
): TimeSeriesPoint[] {
  if (!financials) return [];
  if (isMarketFieldId(source.fieldId)) return extractPriceSeries(financials.priceHistory, source);
  if (isFundamentalFieldId(source.fieldId)) return extractFundamentalSeries(financials, source);
  return [];
}
