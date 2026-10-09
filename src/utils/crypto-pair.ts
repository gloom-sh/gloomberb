import { canonicalExchange, parsePublicTickerKey } from "./exchanges";

// The fiat codes a pair against USD is read as FX for, never as a coin. The
// list Cloud reads: it serves these pairs by the same rule, so a copy judged
// here as current or stale agrees with the answer it was fetched from.
const FIAT_CURRENCY_CODES = new Set([
  "USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "CNY", "CNH", "HKD", "SGD", "SEK", "NOK", "DKK",
  "ZAR", "INR", "BRL", "MXN", "KRW", "TWD", "ILS", "PLN", "TRY", "CZK", "HUF",
]);

const USD_COIN_PAIR = /^([A-Z0-9]+)[-/]USD$/;

/** A coin quoted in dollars (BTC-USD, ETH/USD). EUR-USD is spot FX, not a coin. */
function isUsdCoinPair(symbol: string): boolean {
  const base = USD_COIN_PAIR.exec(symbol.trim().toUpperCase())?.[1];
  return base !== undefined && !FIAT_CURRENCY_CODES.has(base);
}

/**
 * A series that trades around the clock: anything on the crypto venue (CCC), or
 * a coin quoted in dollars whether or not the caller named that venue. A bare
 * BTC-USD is the coin, not a US listing; a bare BTC (no quote) is a US fund.
 */
export function isRoundTheClockCoin(symbol?: string, exchange?: string): boolean {
  const parsed = symbol ? parsePublicTickerKey(symbol) : null;
  if (canonicalExchange(parsed?.exchange ?? exchange) === "CCC" || canonicalExchange(exchange) === "CCC") return true;
  return !!parsed && isUsdCoinPair(parsed.symbol);
}

// A base-quote pair such as BTC-USD or SOL-EUR. Equities with a share-class dash (BRK-B) and
// currency pairs (EURUSD=X) do not match.
const CRYPTO_PAIR = /^[A-Z0-9]{1,15}-(?:USD|EUR|GBP|USDT|USDC|BTC)$/;

/**
 * Wider than isUsdCoinPair, for the hint under a pair that will not load: it
 * also takes pairs quoted in other currencies and in coins, and does not tell
 * a fiat base from a coin.
 */
export function isCryptoPairSymbol(symbol: string): boolean {
  return CRYPTO_PAIR.test(symbol);
}
