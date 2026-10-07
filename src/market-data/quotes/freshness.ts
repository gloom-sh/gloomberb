import type { Quote } from "../../types/financials";
import { isUsListingExchange } from "../../utils/exchanges";
import { zonedDateKey } from "../../utils/zoned-date-time";
import { getPublishedUsEquitySession } from "../published-us-sessions";
import { quoteFutureToleranceMs } from "./clock";
import {
  activeUsExtendedHoursSession,
  isTimestampStaleForExchangeSession,
  isUsPriorSessionPremarketQuote,
  latestRegularSessionClose,
} from "../market/freshness";

/**
 * Receipt time cannot establish when the source observed a quoted price. A
 * stamp slightly ahead of local time is clock skew, not a bad observation.
 */
export function hasValidQuoteObservationTime(quote: Pick<Quote, "lastUpdated">, now = Date.now()): boolean {
  const timestamp = quote.lastUpdated;
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
    && Number.isFinite(now) && timestamp <= now + quoteFutureToleranceMs()
    && Number.isFinite(new Date(timestamp).getTime()) && Number.isFinite(new Date(now).getTime());
}

/** The source date of a validated daily fund observation, including an old NAV. */
export function dailyNavDate(quote: Quote, now = Date.now()): string | null {
  if (quote.priceObservation !== "nav" || quote.instrumentType !== "MUTUALFUND"
    || (quote.priceBasis !== undefined && quote.priceBasis !== "per-unit")
    || !Number.isFinite(quote.price) || quote.price <= 0
    || !hasValidQuoteObservationTime(quote, now) || quote.lastUpdated > now) return null;
  const exchange = quote.listingExchangeName || quote.exchangeName;
  const date = quote.changeSessionDate;
  if (typeof exchange !== "string" || typeof date !== "string"
    || getPublishedUsEquitySession(exchange, date)?.kind !== "session"
    || zonedDateKey(quote.lastUpdated, "America/New_York") !== date) return null;
  return date;
}

function isDailyNavStale(quote: Quote, now: number): boolean {
  const date = dailyNavDate(quote, now);
  if (!date) return true;
  const exchange = quote.listingExchangeName || quote.exchangeName;
  const today = zonedDateKey(now, "America/New_York");
  // Daily NAVs follow the published close plus the daily settlement window.
  // The general session helper can fall back to weekday hours outside calendar
  // coverage, so require published coverage for today and its selected close.
  if (!today || !getPublishedUsEquitySession(exchange!, today) || date > today) return true;
  const settled = latestRegularSessionClose(exchange, now - 30 * 60_000);
  return !settled || getPublishedUsEquitySession(exchange!, settled.date)?.kind !== "session"
    || date < settled.date;
}

export function isExtendedHoursExchange(quote: Quote): boolean {
  return isUsListingExchange(quote.listingExchangeName || quote.exchangeName);
}

function isQuoteMissingActiveSessionPrice(quote: Quote, now: number): boolean {
  if (!isExtendedHoursExchange(quote)) return false;
  const activeSession = activeUsExtendedHoursSession(now);
  if (!activeSession) return false;
  if (quote.marketState !== activeSession) return true;
  if (activeSession === "POST") return quote.postMarketPrice == null;
  // No pre-market trade yet: the previous session's close is the current price.
  return quote.preMarketPrice == null && !isUsPriorSessionPremarketQuote(
    quote.lastUpdated, quote.listingExchangeName || quote.exchangeName, quote.marketState, now,
  );
}

export function isQuoteStaleForCurrentSession(quote: Quote | null | undefined, now = Date.now()): boolean {
  if (!quote) return false;
  if (quote.stale === true) return true;
  if (!hasValidQuoteObservationTime(quote, now)) return true;
  if (quote.priceObservation != null) return isDailyNavStale(quote, now);
  if (isQuoteMissingActiveSessionPrice(quote, now)) return true;

  // A tolerated future stamp belongs to the session in progress, not the next one.
  return isTimestampStaleForExchangeSession(
    Math.min(quote.lastUpdated, now),
    quote.listingExchangeName || quote.exchangeName,
    now,
    quote.marketState,
  );
}

export function hasFreshQuoteForCurrentSession(
  quotes: Iterable<Quote | null | undefined>,
  now = Date.now(),
): boolean {
  for (const quote of quotes) {
    if (quote && !isQuoteStaleForCurrentSession(quote, now)) {
      return true;
    }
  }
  return false;
}
