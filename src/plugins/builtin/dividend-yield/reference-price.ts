import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import { regularSessionValuationTime } from "../../../market-data/quotes/regular-session-valuation";
import type { Quote } from "../../../types/financials";
import { parseReportTime, type ReportTime } from "../../../utils/utc-time";

/** A missing source timestamp must never become the time we fetched its data. */
function dividendPriceAsOf(timestampMs: number | undefined): string | undefined {
  if (timestampMs == null || !Number.isFinite(timestampMs) || timestampMs <= 0 || timestampMs > Date.now()) return undefined;
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** A price time as DVD states it: an ISO instant, or the session date alone when the hour is unknown. */
function priceTimeText(time: ReportTime): string | undefined {
  const instant = dividendPriceAsOf(time.time);
  return instant && time.dateOnly ? instant.slice(0, 10) : instant;
}

/** A stated price time read back (a date stays a date), or undefined when it is none or lies ahead. */
export function dividendPriceTime(priceAsOf: string | null | undefined): string | undefined {
  const time = parseReportTime(priceAsOf);
  return time ? priceTimeText(time) : undefined;
}

/**
 * When the reference price is from. The price is the regular session's
 * (regularSessionValuationPrice), so once that session is over it is dated by
 * its close, or by the session date when the venue's calendar has no hour,
 * never by the after-hours print that last updated the quote. A quote whose
 * own time is missing or ahead of now dates nothing, and its staleness is
 * the quote's for its session.
 */
export function dividendQuotePriceMetadata(quote: Quote) {
  const quoteTime = dividendPriceAsOf(quote.lastUpdated);
  const valuedAt = quoteTime ? regularSessionValuationTime(quote) : null;
  return {
    priceAsOf: valuedAt ? priceTimeText(valuedAt) : undefined,
    priceStale: quote.stale === true || (quoteTime ? isQuoteStaleForCurrentSession(quote) : undefined),
  };
}

export function dividendPriceStatus(
  price: number | null,
  priceAsOf: string | undefined,
  priceStale: boolean | undefined,
): "stale" | "unknown-time" | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  if (priceStale) return "stale";
  return dividendPriceTime(priceAsOf) ? null : "unknown-time";
}
