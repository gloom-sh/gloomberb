import type { Quote } from "../../types/financials";
import { canonicalExchange } from "../../utils/exchanges";
import { isTimestampStaleForExchangeSession } from "../market/freshness";

const EXTENDED_HOURS_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"]);

function isExtendedHoursExchange(quote: Quote): boolean {
  return EXTENDED_HOURS_EXCHANGES.has(canonicalExchange(quote.listingExchangeName || quote.exchangeName));
}

function isQuoteMissingActiveSessionPrice(quote: Quote): boolean {
  if (!isExtendedHoursExchange(quote)) return false;
  if ((quote.marketState === "PRE" || quote.marketState === "PREPRE") && quote.preMarketPrice == null) {
    return true;
  }
  if ((quote.marketState === "POST" || quote.marketState === "POSTPOST") && quote.postMarketPrice == null) {
    return true;
  }
  return false;
}

export function isQuoteStaleForCurrentSession(quote: Quote | null | undefined, now = Date.now()): boolean {
  if (!quote) return false;
  if (quote.stale === true) return true;
  if (isQuoteMissingActiveSessionPrice(quote)) return true;

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
