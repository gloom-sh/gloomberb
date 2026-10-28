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
 * The crypto exchanges whose own lines of a coin pair search lists in a currency the crypto venue quotes coins in,
 * and the venue itself. A slash pair saved on any other venue, or on none, is not read as a coin: on the commodity
 * or currency venue it is spot crude, gold by the gram or a currency (WTI/USD, GAU/USD, RUB/USD).
 */
const COIN_EXCHANGES: ReadonlySet<string> = new Set([
  "CCC", "BIGONE", "BINANCE", "BITBANK", "BITBNS", "BITFINEX", "BITFLYER", "BITHUMB", "BITMART", "BITRUE", "BITSTAMP",
  "BTC MARKETS", "BYBIT", "CEX.IO", "COINBASE PRO", "COINONE", "CRYPTO.COM EXCHANGE", "FREIEXCHANGE", "GATE.IO", "HITBTC",
  "HUOBI", "INDEPENDENT RESERVE", "KRAKEN", "KUCOIN", "LATOKEN", "MEXC", "MXC", "OKEX", "OKX", "POLONIEX", "SYNTHETIC",
  "UNISWAP", "UPBIT", "WAZIRX", "XT.COM", "YOBIT", "ZAIF",
]);

/** Venues whose slash pairs are commodities or currencies, never coins, whatever a row's type says. */
const NOT_COIN_VENUES: ReadonlySet<string> = new Set(["COMMODITY", "CCY", "FX", "FOREX", "CURRENCY", "PHYSICAL CURRENCY"]);

/**
 * Spot commodities written as a pair: gold, silver, platinum and palladium, gold and silver by the gram (GAU,
 * XAGG), WTI, Brent (XBR) and Urals crude, and copper (HG1). Never a coin, though tokens share the letters
 * (GAU-USD is Gamer Arena).
 */
const SPOT_COMMODITY_BASES: ReadonlySet<string> = new Set(["XAU", "GAU", "XAG", "XAGG", "XPT", "XPD", "WTI", "XBR", "URALS", "HG1"]);

/** A spot commodity's pair (WTI/USD, GAU/USD) or a pair on the commodity or currency venue, which no coin is. */
export function isSpotCommodityOrCurrencyPair(symbol: string, exchange?: string): boolean {
  const parsed = parsePublicTickerKey(symbol.trim().toUpperCase());
  const named = (parsed.exchange ?? exchange ?? "").trim().toUpperCase();
  const base = /^([A-Z0-9]{1,15})\//.exec(parsed.symbol)?.[1];
  return !!base && (SPOT_COMMODITY_BASES.has(base) || NOT_COIN_VENUES.has(named) || NOT_COIN_VENUES.has(canonicalExchange(named)));
}

/** The crypto venue's listing of a coin pair written with a slash (BTC/GBP); null for a currency, a spot commodity or another leg. */
function slashCoinPairListing(symbol: string): { symbol: string; exchange: "CCC"; currency: string } | null {
  const match = SLASH_COIN_PAIR.exec(symbol.trim().toUpperCase());
  if (!match) return null;
  const [, base, quote] = match as unknown as [string, string, string];
  if (isIsoCurrencyCode(base) || SPOT_COMMODITY_BASES.has(base) || !VENUE_QUOTE_LEGS.has(quote)) return null;
  return { symbol: `${base}-${quote}`, exchange: "CCC", currency: quote };
}

/**
 * A crypto exchange's own line of a coin pair (BTC/GBP on COINBASE PRO, LINK/EUR on KRAKEN, DOGE/BTC on BINANCE)
 * as the crypto venue's listing of it, in the currency it is quoted in: BTC-GBP on CCC, in pounds. Search offers
 * those lines, and no source quotes them.
 *
 * Only a pair on a crypto exchange (COIN_EXCHANGES) is one, or a search row whose type says it is a coin
 * (`coinRow`) on a venue that is no stock, commodity or currency venue. Null for a currency pair (EUR/USD,
 * RUB/USD), a spot commodity (XAU/USD, WTI/USD), a pair the venue quotes in no such currency (BTC/USDT), a pair
 * with no venue, and a slash on a stock exchange, which is a share class (BRK/B).
 */
export function exchangeLineCoinListing(
  symbol: string,
  exchange?: string,
  { coinRow = false }: { coinRow?: boolean } = {},
): { symbol: string; exchange: "CCC"; currency: string } | null {
  const parsed = parsePublicTickerKey(symbol);
  const listing = slashCoinPairListing(parsed.symbol);
  if (!listing) return null;
  const named = (parsed.exchange ?? exchange ?? "").trim().toUpperCase();
  const venue = canonicalExchange(named);
  if (COIN_EXCHANGES.has(named) || COIN_EXCHANGES.has(venue)) return listing;
  if (!coinRow || !venue || NOT_COIN_VENUES.has(named) || NOT_COIN_VENUES.has(venue)) return null;
  // The crypto venues trade around the clock; a venue the app knows that does not is a stock exchange.
  return isKnownExchangeCode(venue) && EXCHANGE_TIME_ZONES[venue] !== "UTC" ? null : listing;
}

/**
 * A coin pair typed with a slash (btc/gbp) as the crypto venue's listing of it, BTC-GBP on CCC; with a venue
 * (BTC/GBP:KRAKEN), as that exchange's line reads (exchangeLineCoinListing). Null for a currency pair, a spot
 * commodity (wti/usd) and a pair the venue quotes in no such currency.
 */
export function typedCoinPairListing(query: string): { symbol: string; exchange: "CCC"; currency: string } | null {
  const parsed = parsePublicTickerKey(query.trim().toUpperCase());
  return parsed.exchange ? exchangeLineCoinListing(parsed.symbol, parsed.exchange) : slashCoinPairListing(parsed.symbol);
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
    const coin = !row.brokerContract && isCoinRowType(row.type) ? exchangeLineCoinListing(row.symbol, row.exchange, { coinRow: true }) : null;
    if (!coin) return [row];
    changed = true;
    if (offered.has(coin.symbol)) return [];
    offered.add(coin.symbol);
    return [{ ...row, symbol: coin.symbol, exchange: coin.exchange, currency: row.currency || coin.currency }];
  });
  return changed ? mapped : rows;
}

/** Whether a search row's type says it is a coin (CRYPTOCURRENCY, Digital Currency). */
export function isCoinRowType(type: string | undefined): boolean {
  return /CRYPTO|DIGITAL|COIN/i.test(type ?? "");
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
