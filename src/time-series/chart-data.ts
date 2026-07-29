import type { PricePoint, Quote } from "../types/financials";
import { isQuoteStaleForCurrentSession } from "../market-data/quotes/freshness";
import { hasLikelyQuoteUnitMismatch } from "../utils/currency-units";
import {
  CHART_RESOLUTION_STEP_MS,
  type ManualChartResolution,
} from "./resolution";

const MAX_LIVE_QUOTE_TAIL_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_LIVE_QUOTE_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_INTRADAY_BAR_INTERVAL_MS = 6 * 60 * 60_000;
const MIN_LIVE_QUOTE_TAIL_GAP_MS = 5 * 60_000;

export type AppendLiveQuotePointOptions =
  | {
    now?: number;
    mode?: "scalar";
  }
  | {
    now?: number;
    mode: "ohlc";
    resolution: ManualChartResolution;
  };

function coerceDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function getPointTime(point: Pick<PricePoint, "date">): number {
  return coerceDate(point.date as Date | string | number).getTime();
}

function getActiveQuotePrice(quote: Quote): number {
  if ((quote.marketState === "PRE" || quote.marketState === "PREPRE") && quote.preMarketPrice != null) {
    return quote.preMarketPrice;
  }
  if ((quote.marketState === "POST" || quote.marketState === "POSTPOST") && quote.postMarketPrice != null) {
    return quote.postMarketPrice;
  }
  return quote.price;
}

function quoteBelongsToLatestBar(
  latestTime: number,
  quoteTime: number,
  resolution: ManualChartResolution,
): boolean {
  if (quoteTime < latestTime) return false;
  if (resolution === "1mo") {
    const latestDate = new Date(latestTime);
    const quoteDate = new Date(quoteTime);
    return latestDate.getUTCFullYear() === quoteDate.getUTCFullYear()
      && latestDate.getUTCMonth() === quoteDate.getUTCMonth();
  }
  return quoteTime - latestTime < CHART_RESOLUTION_STEP_MS[resolution];
}

function finiteOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mergeQuoteIntoLatestBar(latest: PricePoint, quotePrice: number): PricePoint {
  const open = finiteOrFallback(latest.open, latest.close);
  const high = finiteOrFallback(latest.high, Math.max(open, latest.close));
  const low = finiteOrFallback(latest.low, Math.min(open, latest.close));
  return {
    ...latest,
    open,
    high: Math.max(high, open, latest.close, quotePrice),
    low: Math.min(low, open, latest.close, quotePrice),
    close: quotePrice,
  };
}

export function appendLiveQuotePoint(
  points: PricePoint[],
  quote: Quote | null | undefined,
  options: AppendLiveQuotePointOptions = {},
): PricePoint[] {
  const now = options.now ?? Date.now();
  if (!quote || isQuoteStaleForCurrentSession(quote, now)) return points;

  const quoteTime = quote.lastUpdated;
  const quotePrice = getActiveQuotePrice(quote);
  if (
    !Number.isFinite(quoteTime)
    || !Number.isFinite(quotePrice)
    || quotePrice <= 0
    || quoteTime > now + MAX_LIVE_QUOTE_CLOCK_SKEW_MS
    || now - quoteTime > MAX_LIVE_QUOTE_TAIL_AGE_MS
  ) {
    return points;
  }

  const latest = points.at(-1);
  if (!latest) return points;

  const latestTime = getPointTime(latest);
  if (!Number.isFinite(latestTime) || quoteTime < latestTime) return points;

  const previous = points.at(-2);
  const latestInterval = previous ? latestTime - getPointTime(previous) : Number.NaN;
  if (
    latestInterval > 0
    && latestInterval <= MAX_INTRADAY_BAR_INTERVAL_MS
    && quoteTime - latestTime > Math.max(MIN_LIVE_QUOTE_TAIL_GAP_MS, latestInterval * 3)
  ) {
    return points;
  }

  const latestClose = latest.close;
  if (hasLikelyQuoteUnitMismatch(
    { currency: quote.currency, price: latestClose },
    { currency: quote.currency, price: quotePrice },
  )) {
    return points;
  }

  if (options.mode === "ohlc") {
    if (quoteBelongsToLatestBar(latestTime, quoteTime, options.resolution)) {
      const merged = mergeQuoteIntoLatestBar(latest, quotePrice);
      return [...points.slice(0, -1), merged];
    }
    return [
      ...points,
      {
        date: new Date(quoteTime),
        open: quotePrice,
        high: quotePrice,
        low: quotePrice,
        close: quotePrice,
      },
    ];
  }

  if (quoteTime === latestTime) return points;

  return [
    ...points,
    {
      date: new Date(quoteTime),
      close: quotePrice,
    },
  ];
}
