import type { PricePoint, TickerFinancials } from "../types/financials";
import { pricePointIntegrity, pricePointValues, priceHistoryIntegrityNotice, mergePriceHistoryIntegrity, type PriceHistoryIntegrity } from "../utils/price-history-integrity";
import { canonicalTimeSeriesFieldId, isFundamentalFieldId, isMarketFieldId } from "./field-catalog";
import { extractFundamentalSeries } from "./fundamentals";
import type { ChartSeriesPriceHistoryIntegrity, ResolvedSeries, SecuritySeriesSource, SeriesPeriod, TimeSeriesPoint } from "./types";

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
  integrity?: PriceHistoryIntegrity;
}

/** Aggregates OHLCV correctly: first open, max high, min low, last close, summed volume. */
function aggregatePriceHistory(
  points: readonly PricePoint[],
  period: SeriesPeriod,
): Array<PricePoint & { integrity?: PriceHistoryIntegrity }> {
  const sorted = points
    .flatMap((point) => {
      const date = pricePointDate(point.date);
      const integrity = pricePointIntegrity(point);
      return date && (finiteNumber(point.close) || integrity) ? [{ ...point, date, integrity }] : [];
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
        integrity: point.integrity,
      });
      continue;
    }
    current.date = new Date(point.date);
    current.high = Math.max(current.high, high);
    current.low = Math.min(current.low, low);
    current.close = point.close;
    if (point.integrity) current.integrity = current.integrity
      ? mergePriceHistoryIntegrity(current.integrity, point.integrity) : point.integrity;
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
    const { integrity, ...values } = pricePointValues(point, point.integrity);
    const value = fieldId === "market.open"
      ? values.open
      : fieldId === "market.high"
        ? values.high
        : fieldId === "market.low"
          ? values.low
          : fieldId === "market.volume"
            ? values.volume
            : values.close;
    return {
      date: new Date(point.date),
      observedAt: new Date(point.date),
      availableAt: new Date(point.date),
      value,
      ...values,
      provenance: { quality: "reported" as const, ...(integrity ? { priceHistoryIntegrity: integrity } : {}) },
    };
  });
}

export function priceHistoryIntegrityNotices(series: readonly Pick<ResolvedSeries, "label" | "points">[]): string[] {
  return series.flatMap((entry) => {
    const dates = new Set(entry.points.flatMap((point) => point.provenance?.priceHistoryIntegrity?.sourcePoints.map((source) => source.date) ?? []));
    const notice = priceHistoryIntegrityNotice(dates.size);
    return notice ? [`${entry.label}: ${notice}`] : [];
  });
}

export function collectPriceHistoryIntegrity(
  series: readonly Pick<ResolvedSeries, "id" | "label" | "points">[],
  scope: ChartSeriesPriceHistoryIntegrity["scope"],
  includeSource?: (seriesId: string, sourceTime: number) => boolean,
): ChartSeriesPriceHistoryIntegrity[] {
  return series.flatMap((entry) => {
    const sources = new Map<string, PriceHistoryIntegrity["sourcePoints"][number]>();
    for (const point of entry.points) {
      for (const source of point.provenance?.priceHistoryIntegrity?.sourcePoints ?? []) {
        if (!includeSource || includeSource(entry.id, Date.parse(source.date))) sources.set(JSON.stringify(source), source);
      }
    }
    return sources.size ? [{
      seriesId: entry.id, label: entry.label, scope,
      integrity: mergePriceHistoryIntegrity({ reason: "inconsistent-ohlc", sourcePoints: [...sources.values()] }),
    }] : [];
  });
}

export function chartPriceHistoryIntegrityNotices(entries: readonly ChartSeriesPriceHistoryIntegrity[]): string[] {
  const bySeries = new Map<string, { label: string; dates: Set<string> }>();
  for (const entry of entries) {
    const group = bySeries.get(entry.seriesId) ?? { label: entry.label, dates: new Set<string>() };
    entry.integrity.sourcePoints.forEach((source) => group.dates.add(source.date));
    bySeries.set(entry.seriesId, group);
  }
  return [...bySeries.values()].map(({ label, dates }) => `${label}: ${priceHistoryIntegrityNotice(dates.size)}`);
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
