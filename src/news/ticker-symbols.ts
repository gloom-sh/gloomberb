import { isPredictionMarketExchange, isUsListingExchange, parsePublicTickerKey } from "../utils/exchanges";

/**
 * A story's tag for a listing: the bare symbol on a US venue (or over the
 * counter) and for a coin, the symbol and its venue elsewhere. PIK on the JSE
 * is Pick n Pay, and bare PIK opens Kidpik on NASDAQ.
 */
function newsDisplayTickerSymbol(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return null;
  const listing = parsePublicTickerKey(normalized);
  const venue = listing.exchange ?? "";
  if (!listing.symbol) return null;
  if (isPredictionMarketExchange(venue)) return normalized;
  return !venue || isUsListingExchange(venue) || venue.startsWith("OTC") || venue === "CRYPTO"
    ? listing.symbol
    : `${listing.symbol}:${venue}`;
}

export function collectNewsDisplayTickers(
  values: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const tickers: string[] = [];

  for (const value of values) {
    const symbol = newsDisplayTickerSymbol(value);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    tickers.push(symbol);
  }

  return tickers;
}
