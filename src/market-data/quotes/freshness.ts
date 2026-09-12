import type { Quote } from "../../types/financials";
import { canonicalExchange } from "../../utils/exchanges";
import { activeUsExtendedHoursSession, isTimestampStaleForExchangeSession } from "../market/freshness";

const EXTENDED_HOURS_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"]);

export function isExtendedHoursExchange(quote: Quote): boolean {
  return EXTENDED_HOURS_EXCHANGES.has(canonicalExchange(quote.listingExchangeName || quote.exchangeName));
}

function isQuoteMissingActiveSessionPrice(quote: Quote, now: number): boolean {
  if (!isExtendedHoursExchange(quote)) return false;
  const activeSession = activeUsExtendedHoursSession(now);
  if (!activeSession) return false;
  if (quote.marketState !== activeSession) return true;
  return activeSession === "PRE" ? quote.preMarketPrice == null : quote.postMarketPrice == null;
}

export function isQuoteStaleForCurrentSession(quote: Quote | null | undefined, now = Date.now()): boolean {
  if (!quote) return false;
  if (quote.stale === true) return true;
  if (isQuoteMissingActiveSessionPrice(quote, now)) return true;

  return isTimestampStaleForExchangeSession(
    quote.lastUpdated,
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
