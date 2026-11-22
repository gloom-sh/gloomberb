import { TOP_COIN_NAMES } from "../utils/crypto-pair";
import { isUsListingExchange } from "../utils/exchanges";
import { classifyInstrumentKind } from "../tickers/search/ranking";

let stocks: ReadonlySet<string> | undefined;

/**
 * Whether the listings shipped with the app list the symbol as a stock on a US exchange that still trades, and no top
 * coin is known by it (SOL is a coin before it is a company). A line the file marks as stopped (CS, Credit Suisse's
 * NYSE receipt) is not one: its symbol is read as any other bare code is, past the line that stopped. Read from the
 * shipped file the first time it is asked, a couple of milliseconds, so a command that never looks up a symbol does
 * not load it.
 */
export function isKnownUsStock(symbol: string): boolean {
  stocks ??= new Set((require("../tickers/search/major-listings.json") as { listings: ReadonlyArray<readonly unknown[]> }).listings
    .filter(([, , exchange, type, , , , , extra]) => isUsListingExchange(String(exchange)) && classifyInstrumentKind(String(type)) === "equity"
      && !(extra && typeof extra === "object" && "delisting" in extra))
    .map(([listed]) => String(listed).toUpperCase()));
  const wanted = symbol.trim().toUpperCase();
  return stocks.has(wanted) && !TOP_COIN_NAMES.has(wanted);
}
