import { canonicalExchange, EXCHANGE_TIME_ZONES, isKnownExchangeCode, parsePublicTickerKey } from "./exchanges";

// The fiat codes a pair against USD is read as FX for, never as a coin. The
// list Cloud reads: it serves these pairs by the same rule, so a copy judged
// here as current or stale agrees with the answer it was fetched from.
const FIAT_CURRENCY_CODES = new Set([
  "USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "CNY", "CNH", "HKD", "SGD", "SEK", "NOK", "DKK",
  "ZAR", "INR", "BRL", "MXN", "KRW", "TWD", "ILS", "PLN", "TRY", "CZK", "HUF",
]);

const USD_COIN_PAIR = /^([A-Z0-9]+)[-/]USD$/;
// The other currencies and coins the crypto venue quotes a coin in (BTC-EUR, BTC-JPY, ETH-BTC).
const QUOTED_COIN_PAIR = /^([A-Z0-9]+)[-/](?:USDT|USDC|EUR|GBP|JPY|KRW|CAD|INR|CNY|AUD|BTC|ETH)$/;

/** A coin quoted in dollars (BTC-USD, ETH/USD). EUR-USD is spot FX, not a coin. */
function isUsdCoinPair(symbol: string): boolean {
  const base = USD_COIN_PAIR.exec(symbol.trim().toUpperCase())?.[1];
  return base !== undefined && !FIAT_CURRENCY_CODES.has(base);
}

/** A coin quoted in another currency or coin (BTC-EUR, ETH-BTC). EUR-GBP is spot FX, not a coin. */
function isQuotedCoinPair(symbol: string): boolean {
  const base = QUOTED_COIN_PAIR.exec(symbol.trim().toUpperCase())?.[1];
  return base !== undefined && !isIsoCurrencyCode(base);
}

/**
 * A series that trades around the clock: anything on the crypto venue (CCC), or
 * a coin quoted in dollars whether or not the caller named that venue. A bare
 * BTC-USD is the coin, not a US listing; a bare BTC (no quote) is a US fund. A
 * bare coin quoted in euros or in another coin (BTC-EUR) is the coin too, never
 * a US listing whose session closed at 16:00 New York.
 */
export function isRoundTheClockCoin(symbol?: string, exchange?: string): boolean {
  const parsed = symbol ? parsePublicTickerKey(symbol) : null;
  const venue = canonicalExchange(parsed?.exchange ?? exchange) || canonicalExchange(exchange);
  if (venue === "CCC" || canonicalExchange(exchange) === "CCC") return true;
  if (parsed && exchangeLineCoinListing(parsed.symbol, venue)) return true;
  return !!parsed && (isUsdCoinPair(parsed.symbol) || (!venue && isQuotedCoinPair(parsed.symbol)));
}

const SLASH_COIN_PAIR = /^([A-Z0-9]{1,15})\/(USD|EUR|GBP|JPY|KRW|CAD|INR|CNY|AUD|USDT|USDC|BTC|ETH)$/;

/**
 * What the crypto venue (CCC) quotes a coin in: BTC-GBP, BTC-KRW, LINK-ETH.
 * It has no coin in a stablecoin (BTC-USDT) or in most other currencies
 * (BTC-TRY, BTC-BRL).
 */
const VENUE_QUOTE_LEGS: ReadonlySet<string> = new Set(["USD", "EUR", "GBP", "JPY", "KRW", "CAD", "INR", "CNY", "AUD", "BTC", "ETH"]);

let isoCurrencyCodes: ReadonlySet<string> | null = null;

/** Every ISO currency code the runtime knows (THB, ARS, XAU), so a pair on one is never read as a coin. */
export function isIsoCurrencyCode(code: string): boolean {
  isoCurrencyCodes ??= new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : []);
  return FIAT_CURRENCY_CODES.has(code) || isoCurrencyCodes.has(code);
}

/**
 * BTC-USD for BTC/USD, the way crypto venues write a pair; null for anything
 * else, a currency pair such as EUR/USD or XAU/USD included.
 */
export function dashedCoinPair(symbol: string): string | null {
  const match = SLASH_COIN_PAIR.exec(symbol.trim().toUpperCase());
  if (!match || isIsoCurrencyCode(match[1]!)) return null;
  return `${match[1]}-${match[2]}`;
}

/**
 * A crypto exchange's own line of a coin pair (BTC/GBP on COINBASE PRO, LINK/EUR
 * on KRAKEN, DOGE/BTC on BINANCE) as the crypto venue's listing of it, in the
 * currency it is quoted in: BTC-GBP on CCC, in pounds. Search offers those
 * lines, and no source quotes them. Null for a currency pair (EUR/USD), a
 * metal (XAU/USD), a pair the venue quotes in no such currency (BTC/USDT),
 * and a slash on a stock exchange, which is a share class (BRK/B).
 */
export function exchangeLineCoinListing(symbol: string, exchange?: string): { symbol: string; exchange: "CCC"; currency: string } | null {
  const parsed = parsePublicTickerKey(symbol);
  const match = SLASH_COIN_PAIR.exec(parsed.symbol);
  if (!match || isIsoCurrencyCode(match[1]!) || !VENUE_QUOTE_LEGS.has(match[2]!)) return null;
  const venue = canonicalExchange(parsed.exchange ?? exchange);
  // The crypto venues trade around the clock; a venue the app knows that does not is a stock exchange.
  if (venue && isKnownExchangeCode(venue) && EXCHANGE_TIME_ZONES[venue] !== "UTC") return null;
  return { symbol: `${match[1]}-${match[2]}`, exchange: "CCC", currency: match[2]! };
}

/**
 * Search rows with each crypto exchange's line of a coin pair (ETH/EUR on KRAKEN, COINBASE PRO, BITSTAMP and
 * BINANCE) as the crypto venue's one listing of it, ETH-EUR on CCC in euros, where the first line stood. A pair
 * already offered on the venue is not offered twice. Newer servers send the listing themselves.
 */
export function withExchangeLinesAsCoinListings<T extends { symbol: string; exchange: string; type: string; currency?: string; brokerContract?: unknown }>(rows: T[]): T[] {
  const offered = new Set(rows.filter((row) => canonicalExchange(row.exchange) === "CCC").map((row) => row.symbol.trim().toUpperCase()));
  let changed = false;
  const mapped = rows.flatMap((row) => {
    const coin = !row.brokerContract && /CRYPTO|DIGITAL|COIN/i.test(row.type) ? exchangeLineCoinListing(row.symbol, row.exchange) : null;
    if (!coin) return [row];
    changed = true;
    if (offered.has(coin.symbol)) return [];
    offered.add(coin.symbol);
    return [{ ...row, symbol: coin.symbol, exchange: coin.exchange, currency: row.currency || coin.currency }];
  });
  return changed ? mapped : rows;
}

/** The currency or coin a pair on the crypto venue is quoted in: GBP for BTC-GBP; null for anything else. */
export function coinPairQuoteCurrency(symbol: string): string | null {
  const match = /^([A-Z0-9]{1,15})-([A-Z]{3})$/.exec(parsePublicTickerKey(symbol).symbol);
  return match && !isIsoCurrencyCode(match[1]!) && VENUE_QUOTE_LEGS.has(match[2]!) ? match[2]! : null;
}

// A base-quote pair such as BTC-USD or SOL-EUR. Equities with a share-class dash (BRK-B) and
// currency pairs (EURUSD=X) do not match.
const CRYPTO_PAIR = /^[A-Z0-9]{1,15}-(?:USD|EUR|GBP|JPY|KRW|CAD|INR|CNY|AUD|USDT|USDC|BTC|ETH)$/;

/**
 * Wider than isUsdCoinPair, for the hint under a pair that will not load: it
 * also takes pairs quoted in other currencies and in coins, and does not tell
 * a fiat base from a coin.
 */
export function isCryptoPairSymbol(symbol: string): boolean {
  return CRYPTO_PAIR.test(symbol);
}

/**
 * The coins whose bare ticker is most often typed for the coin itself, with
 * how stories and notes name each: the name a listing's own may not say
 * plainly ("Bitcoin USD").
 */
export const MAJOR_COIN_NAMES: ReadonlyMap<string, string> = new Map([
  ["BTC", "bitcoin"],
  ["ETH", "ethereum"],
  ["SOL", "solana"],
  ["XRP", "XRP"],
  ["DOGE", "dogecoin"],
  ["ADA", "cardano"],
  ["LTC", "litecoin"],
  ["BCH", "bitcoin cash"],
  ["AVAX", "avalanche"],
  ["DOT", "polkadot"],
  ["LINK", "chainlink"],
  ["BNB", "BNB"],
]);

/**
 * The largest coins by market value, stablecoins and gold tokens left out, with
 * how a note names each: the coins whose bare ticker a listed company or fund
 * may hold instead (SOL is a stale Emeren Group, LINK is Interlink Electronics).
 * A hint reads this list; `MAJOR_COIN_NAMES` stays the shorter one stories and
 * company-name lookups use, so a word such as "stellar" is still a company's.
 */
export const TOP_COIN_NAMES: ReadonlyMap<string, string> = new Map([
  ...MAJOR_COIN_NAMES,
  ["TRX", "tron"],
  ["ZEC", "zcash"],
  ["HYPE", "hyperliquid"],
  ["XMR", "monero"],
  ["XLM", "stellar"],
  ["NEAR", "near protocol"],
  ["TON", "toncoin"],
  ["UNI", "uniswap"],
  ["SUI", "sui"],
  ["HBAR", "hedera"],
  ["TAO", "bittensor"],
  ["SHIB", "shiba inu"],
  ["ENA", "ethena"],
  ["CRO", "cronos"],
  ["AAVE", "aave"],
  ["ONDO", "ondo"],
  ["PEPE", "pepe"],
  ["ICP", "internet computer"],
  ["ETC", "ethereum classic"],
  ["ARB", "arbitrum"],
  ["ALGO", "algorand"],
  ["ATOM", "cosmos"],
  ["APT", "aptos"],
  ["FIL", "filecoin"],
  ["POL", "polygon"],
  ["OP", "optimism"],
  ["WLD", "worldcoin"],
  ["MNT", "mantle"],
  ["KAS", "kaspa"],
  ["QNT", "quant"],
  ["VET", "vechain"],
  ["INJ", "injective"],
  ["RENDER", "render"],
]);

const COIN_PAIR = /^([A-Z0-9]{1,15})[-/](?:USD|EUR|GBP|JPY|KRW|CAD|INR|CNY|AUD|USDT|USDC|BTC|ETH)$/;
// What a pair's listing name adds after the coin's: its quote currency, an id in brackets.
// Not ETH, which ends coins' own names (Lido Staked ETH).
const PAIR_NAME_SUFFIX = /(?:\s*\([^)]*\))+$|\s+(?:USD|EUR|GBP|JPY|KRW|CAD|INR|CNY|AUD|USDT|USDC|BTC|US Dollars?)$/i;

/**
 * The coin a crypto pair trades, as stories name it: "bitcoin" for BTC-USD
 * (or BTC-USD on CCC), from the major coins' names, else the listing's name
 * without its quote currency ("Hyperliquid USD" is "hyperliquid"). Null for a
 * symbol that is not a coin pair, and for a coin with no name to search for:
 * its code alone (TON, UNI) is too often a word.
 */
export function coinSearchName(symbol: string | undefined, exchange?: string, listingName?: string | null): string | null {
  if (!symbol || !isRoundTheClockCoin(symbol, exchange)) return null;
  const parsed = parsePublicTickerKey(symbol).symbol.trim().toUpperCase();
  const code = COIN_PAIR.exec(parsed)?.[1] ?? parsed;
  if (isIsoCurrencyCode(code)) return null;
  const major = MAJOR_COIN_NAMES.get(code);
  if (major) return major;
  let name = listingName?.trim() ?? "";
  for (let previous = ""; previous !== name;) {
    previous = name;
    name = name.replace(PAIR_NAME_SUFFIX, "").trim();
  }
  if (name.length < 3 || name.toUpperCase() === code || !/\p{L}/u.test(name)) return null;
  return name === name.toUpperCase() ? name : name.toLowerCase();
}
