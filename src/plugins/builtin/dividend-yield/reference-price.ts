import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import type { Quote } from "../../../types/financials";

/** A missing source timestamp must never become the time we fetched its data. */
export function dividendPriceAsOf(timestampMs: number | undefined): string | undefined {
  if (timestampMs == null || !Number.isFinite(timestampMs) || timestampMs <= 0 || timestampMs > Date.now()) return undefined;
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function dividendQuotePriceMetadata(quote: Quote) {
  const priceAsOf = dividendPriceAsOf(quote.lastUpdated);
  return {
    priceAsOf,
    priceStale: quote.stale === true || (priceAsOf ? isQuoteStaleForCurrentSession(quote) : undefined),
  };
}

export function dividendPriceStatus(
  price: number | null,
  priceAsOf: string | undefined,
  priceStale: boolean | undefined,
): "stale" | "unknown-time" | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  if (priceStale) return "stale";
  return dividendPriceAsOf(Date.parse(priceAsOf ?? "")) ? null : "unknown-time";
}
