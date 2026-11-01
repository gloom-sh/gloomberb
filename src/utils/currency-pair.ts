import { canonicalExchange, parsePublicTickerKey } from "./exchanges";
import { isIsoCurrencyCode } from "./crypto-pair";

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

// ISO codes that are no currency anyone trades as a pair here: metals (XAU is
// spot gold, which has its own answer), drawing rights and bond units, and the
// testing and no-currency codes.
const NON_CURRENCY_CODES = new Set([
  "XAU", "XAG", "XPT", "XPD", "XDR", "XSU", "XUA", "XBA", "XBB", "XBC", "XBD", "XTS", "XXX", "XEU", "XFO", "XFU", "XRE",
]);

/** Whether `code` is a currency code a pair can be written with: ISO 4217, less metals, drawing rights and testing codes. */
export function isCurrencyCode(code: string): boolean {
  return !NON_CURRENCY_CODES.has(code) && isIsoCurrencyCode(code);
}

export interface CurrencyPairSpelling {
  /** The pair as Gloom Cloud lists it on the currency venue: USDNGN=X for USD/NGN, USDJPY=X for JPY=X. */
  symbol: string;
  /**
   * Whether a security could be written the same way: USD-NGN as a coin venue
   * writes a pair (MNT-USD is a coin), USDNGN as a six-letter ticker. Only
   * search can say which one such a spelling is.
   */
  ambiguous: boolean;
}

const LISTED_PAIR = /^([A-Z]{3})([A-Z]{3})=X$/;
const DOLLAR_PAIR = /^([A-Z]{3})=X$/;
const SEPARATED_PAIR = /^([A-Z]{3})([/-])([A-Z]{3})$/;
const BARE_PAIR = /^([A-Z]{3})([A-Z]{3})$/;

/**
 * One spelling for a currency pair however it was typed, so every spelling is
 * one request and one cached answer: USD/NGN, usd/ngn, USDNGN=X, USDNGN:CCY,
 * USD-NGN and USDNGN are all USDNGN=X, and JPY=X, the dollar pair's short
 * spelling, is USDJPY=X. Both halves must be currency codes, so BTC-USD and
 * BRK-B are no pair. A listing on any venue but the currency venue is not one
 * either. Null for anything else.
 */
export function currencyPairSpelling(typed: string, exchange?: string): CurrencyPairSpelling | null {
  const listing = parsePublicTickerKey(typed);
  const venue = canonicalExchange(listing.exchange ?? exchange);
  if (venue && venue !== "CCY") return null;
  const onCurrencyVenue = venue === "CCY";
  const code = listing.symbol;
  const pair = (base: string, quote: string, ambiguous: boolean): CurrencyPairSpelling | null => (
    base !== quote && isCurrencyCode(base) && isCurrencyCode(quote) ? { symbol: `${base}${quote}=X`, ambiguous } : null
  );
  let match = LISTED_PAIR.exec(code);
  if (match) return pair(match[1]!, match[2]!, false);
  match = DOLLAR_PAIR.exec(code);
  if (match) return pair("USD", match[1]!, false);
  match = SEPARATED_PAIR.exec(code);
  if (match) return pair(match[1]!, match[3]!, match[2] === "-" && !onCurrencyVenue);
  match = BARE_PAIR.exec(code);
  return match ? pair(match[1]!, match[2]!, !onCurrencyVenue) : null;
}

/**
 * Whether a symbol is written the way a currency pair is, with one half a
 * currency code: USD/XYZ, USD_NGN, USDNGM, XYZ=X. A miss on one is worth
 * asking search which pair was meant.
 */
export function looksLikeCurrencyPair(symbol: string): boolean {
  const code = parsePublicTickerKey(symbol).symbol;
  const halves = /^([A-Z]{3})[^A-Z0-9]?([A-Z]{3})(?:=X)?$/.exec(code)?.slice(1) ?? /^([A-Z]{3})=X$/.exec(code)?.slice(1) ?? [];
  return halves.some(isCurrencyCode);
}

/**
 * Which currency of a pair markets quote it per: EUR, GBP, AUD and NZD go
 * before the dollar, the dollar before CAD, CHF and the rest, and the yen goes
 * last (EUR/USD, USD/CAD, USD/JPY, EUR/CAD, CAD/JPY).
 */
const PAIR_BASE_ORDER = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF"];

function pairBaseRank(code: string): number {
  const at = PAIR_BASE_ORDER.indexOf(code);
  if (at >= 0) return at;
  return code === "JPY" ? PAIR_BASE_ORDER.length + 1 : PAIR_BASE_ORDER.length;
}

/** A currency's pair against the dollar, as markets quote it and as a listing: EURUSD=X for the euro, USDCHF=X for the franc. */
export function dollarPairListing(code: string): string {
  const currency = code.trim().toUpperCase();
  return pairBaseRank(currency) < pairBaseRank("USD") ? `${currency}USD=X` : `USD${currency}=X`;
}

/**
 * A rate of `quote` per unit of `currency`, written the way markets quote
 * the pair, as `fx` reads a pair: 0.0067 USD per JPY is USD/JPY 149.25, and
 * 1.4 CAD per USD stays USD/CAD 1.4. Two codes of the same rank keep their
 * order.
 */
export function quotedFxPair(currency: string, quote: string, rate: number): { pair: string; rate: number } {
  const from = currency.trim().toUpperCase(), into = quote.trim().toUpperCase();
  return pairBaseRank(into) < pairBaseRank(from)
    ? { pair: `${into}/${from}`, rate: 1 / rate }
    : { pair: `${from}/${into}`, rate };
}
