import { canonicalExchange, parsePublicTickerKey } from "./exchanges";

/**
 * The pair an FX listing names, base then quote, in any spelling: EURUSD for
 * EUR/USD, EURUSD=X and EURUSD on the currency venue (EURUSD:CCY, EURUSD:FX);
 * USDJPY for USD/JPY, USDJPY=X and JPY=X, the dollar pair's short spelling.
 * Six bare letters are a pair only on the currency venue, so a six-letter
 * ticker elsewhere never reads as one. Null for anything else.
 */
export function currencyPairCode(symbol: string, exchange?: string): string | null {
  const listing = parsePublicTickerKey(symbol);
  const code = listing.symbol;
  const onCurrencyVenue = canonicalExchange(listing.exchange ?? exchange) === "CCY";
  const pair = /^([A-Z]{3})\/([A-Z]{3})$/.exec(code) ?? /^([A-Z]{3})([A-Z]{3})=X$/.exec(code)
    ?? (onCurrencyVenue ? /^([A-Z]{3})([A-Z]{3})$/.exec(code) : null);
  if (pair) return `${pair[1]}${pair[2]}`;
  const dollarPair = /^([A-Z]{3})=X$/.exec(code);
  return dollarPair ? `USD${dollarPair[1]}` : null;
}
