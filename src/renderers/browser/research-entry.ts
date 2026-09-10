import { tickerHasYahooSuffix } from "../../sources/yahoo-finance/symbols";
import { parsePublicTickerKey, publicTickerKey } from "../../utils/exchanges";

export function researchEntryFromSearch(search: string): { symbol: string; tab: string } | null {
  const params = new URLSearchParams(search);
  const symbol = params.get("ticker")?.trim().toUpperCase();
  if (!symbol) return null;
  const requested = parsePublicTickerKey(symbol);
  const validSymbol = /^[A-Z0-9.^=_-]{1,24}$/.test(requested.symbol)
    || /^[A-Z0-9][A-Z0-9._-]{0,14}\/[A-Z0-9][A-Z0-9._-]{0,14}$/.test(requested.symbol);
  if (!validSymbol) return null;
  const exchange = params.get("exchange")?.trim().toUpperCase();
  if ([exchange, requested.exchange].some((venue) => venue && !/^[A-Z0-9][A-Z0-9 ._-]{0,31}$/.test(venue))) return null;
  // Carry a separate venue through the same listing-qualified resolver used by
  // search and deep links. An explicit symbol suffix/key remains authoritative.
  const target = exchange && !requested.exchange && !tickerHasYahooSuffix(symbol)
    ? publicTickerKey(symbol, exchange)
    : symbol;
  const tab = params.get("tab") ?? "overview";
  return { symbol: target, tab: /^[a-z-]{1,40}$/.test(tab) ? tab : "overview" };
}
