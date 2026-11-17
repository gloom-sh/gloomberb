import { TOP_COIN_NAMES } from "../utils/crypto-pair";
import { isUsListingExchange } from "../utils/exchanges";
import { classifyInstrumentKind } from "../tickers/search/ranking";

let stocks: ReadonlySet<string> | undefined;

/**
 * Whether the listings shipped with the app list the symbol as a stock on a US exchange, and no top coin is known by
 * it (SOL is a coin before it is a company). Read from the shipped file the first time it is asked, a couple of
 * milliseconds, so a command that never looks up a symbol does not load it.
 */
export function isKnownUsStock(symbol: string): boolean {
  stocks ??= new Set((require("../tickers/search/major-listings.json") as { listings: ReadonlyArray<readonly unknown[]> }).listings
    .filter(([, , exchange, type]) => isUsListingExchange(String(exchange)) && classifyInstrumentKind(String(type)) === "equity")
    .map(([listed]) => String(listed).toUpperCase()));
  const wanted = symbol.trim().toUpperCase();
  return stocks.has(wanted) && !TOP_COIN_NAMES.has(wanted);
}
