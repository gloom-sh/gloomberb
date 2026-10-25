import type { TickerRecord } from "../../types/ticker";
import { tickerHasListingSuffix } from "../../sources/listing-symbols";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../../utils/exchanges";
import { listingAbroadVenue } from "../../utils/sec";
import { tickerChangeSymbol } from "../ticker-changes";

/**
 * One rule for a bare symbol, whatever the profile saved before: a US-shaped
 * symbol (SHEL, not SHEL.L, SHEL:LSE or 7203) is its US listing whenever it
 * has one. A saved listing abroad (SHEL on LSE, saved from SHEL.L under the
 * bare key) answers for it only when the symbol lists on no US exchange
 * (GARAN, on BIST alone).
 */
function isBareUsShapedSymbol(symbol: string): boolean {
  return !symbol.includes(":") && !!tickerChangeSymbol(symbol) && !tickerHasListingSuffix(symbol);
}

/** Whether a saved row is a listing abroad that a bare US-shaped symbol settles on only when it has no US listing. */
export function savedAbroadForBareSymbol(symbol: string, ticker: TickerRecord): boolean {
  if (!isBareUsShapedSymbol(symbol)) return false;
  const venue = savedVenue(ticker);
  return !!venue && !!listingAbroadVenue(`${symbol}:${venue}`);
}

function savedVenue(ticker: TickerRecord): string {
  return canonicalExchange(ticker.metadata.exchange || parsePublicTickerKey(ticker.metadata.ticker).exchange);
}

/** The saved row of a bare symbol's US listing, under any key (SHEL:NYSE beside SHEL on LSE); null when none is saved. */
export function savedUsListingOf(symbol: string, tickers: Iterable<TickerRecord>): TickerRecord | null {
  for (const ticker of tickers) {
    if (parsePublicTickerKey(ticker.metadata.ticker).symbol !== symbol) continue;
    if (isUsListingExchange(savedVenue(ticker))) return ticker;
  }
  return null;
}
