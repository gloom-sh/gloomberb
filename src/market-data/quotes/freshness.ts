import type { Quote } from "../../types/financials";
import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import { zonedDateKey } from "../../utils/zoned-date-time";
import { getPublishedUsEquitySession } from "../published-us-sessions";
import { quoteFutureToleranceMs } from "./clock";
import {
  activeUsExtendedHoursSession,
  isAlwaysOpenExchange,
  isTimestampStaleForExchangeSession,
  isUsPriorSessionPremarketQuote,
  isUsRegularCloseQuoteInPostSession,
  latestRegularSessionClose,
  latestRegularSessionOpen,
} from "../market/freshness";

// Give the next regular session's NAV time to publish after its actual close.
const NAV_PUBLICATION_ALLOWANCE_MS = 12 * 60 * 60_000;

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
  if (!today || !getPublishedUsEquitySession(exchange!, today) || date > today) return true;
  const sourceDay = Date.parse(`${date}T00:00:00Z`);
  for (let ahead = 1; ahead <= 10; ahead++) {
    const nextDate = new Date(sourceDay + ahead * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const next = getPublishedUsEquitySession(exchange!, nextDate);
    if (!next) return true;
    if (next.kind === "session") return now >= next.close + NAV_PUBLICATION_ALLOWANCE_MS;
  }
  return true;
}

export function isExtendedHoursExchange(quote: Quote): boolean {
  return isUsListingExchange(quote.listingExchangeName || quote.exchangeName);
}

function isQuoteMissingActiveSessionPrice(quote: Quote, now: number): boolean {
  if (!isExtendedHoursExchange(quote)) return false;
  const activeSession = activeUsExtendedHoursSession(now);
  if (!activeSession) return false;
  // No after-hours trade yet: today's regular close is the current price.
  if (activeSession === "POST" && quote.postMarketPrice == null && isUsRegularCloseQuoteInPostSession(
    quote.lastUpdated, quote.listingExchangeName || quote.exchangeName, quote.marketState, now,
  )) return false;
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

/** Spot FX: its week is in `fx-market-hours`, not a session calendar. */
const FX_VENUE = "CCY";
/** Every venue with sessions has had one within this long; Spring Festival can close TWSE for twelve days. */
const LONGEST_SESSION_GAP_MS = 14 * 24 * 60 * 60_000;

/**
 * Whether a quote's last print is older than its venue's latest completed
 * regular session: a whole session traded since, so the state its source
 * reports says where the market is, not where this price is (a delisted
 * line read as OPEN). Only a quote already stale for its session can be;
 * the last session's close before the open, an after-hours print after it,
 * and round-the-clock venues and FX keep their state. A venue without a
 * calendar counts a print older than any venue goes between sessions.
 */
export function isQuoteBeforeLatestSession(quote: Quote | null | undefined, now = Date.now()): boolean {
  if (!quote || !isQuoteStaleForCurrentSession(quote, now)) return false;
  const venue = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  if (venue === FX_VENUE || isAlwaysOpenExchange(venue)) return false;
  const printed = quote.lastUpdated;
  if (!Number.isFinite(printed) || printed <= 0 || printed > now) return false;
  const latest = latestRegularSessionClose(venue, now);
  if (!latest) return now - printed > LONGEST_SESSION_GAP_MS;
  const open = latestRegularSessionOpen(venue, latest.close);
  return open != null ? printed < open : zonedDateKey(printed, latest.timeZone) < latest.date;
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
