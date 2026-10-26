import { isRoundTheClockCoin } from "../utils/crypto-pair";
import { currencyPairCode, isCurrencyCode } from "../utils/currency-pair";
import { parsePublicTickerKey } from "../utils/exchanges";
import { parseFuturesGeneric } from "../utils/futures-generic";

/** A US-listed fund whose options track an instrument that has none of its own. */
export interface ListedOptionsAlternative {
  symbol: string;
  name: string;
}

/**
 * Futures roots with no option chain here, and the listed fund whose options
 * are the nearest stand-in. One table for every surface that says so.
 */
const FUTURES_ALTERNATIVES: Readonly<Record<string, ListedOptionsAlternative>> = {
  GC: { symbol: "GLD", name: "SPDR Gold Shares" },
  SI: { symbol: "SLV", name: "iShares Silver Trust" },
  HG: { symbol: "CPER", name: "United States Copper Index Fund" },
  PL: { symbol: "PPLT", name: "abrdn Physical Platinum Shares" },
  PA: { symbol: "PALL", name: "abrdn Physical Palladium Shares" },
  CL: { symbol: "USO", name: "United States Oil Fund" },
  BZ: { symbol: "BNO", name: "United States Brent Oil Fund" },
  NG: { symbol: "UNG", name: "United States Natural Gas Fund" },
  LTH: { symbol: "LIT", name: "Global X Lithium & Battery Tech ETF" },
  UX: { symbol: "URA", name: "Global X Uranium ETF" },
  ZC: { symbol: "CORN", name: "Teucrium Corn Fund" },
  ZW: { symbol: "WEAT", name: "Teucrium Wheat Fund" },
  ZS: { symbol: "SOYB", name: "Teucrium Soybean Fund" },
  ES: { symbol: "SPY", name: "SPDR S&P 500 ETF" },
  NQ: { symbol: "QQQ", name: "Invesco QQQ Trust" },
  YM: { symbol: "DIA", name: "SPDR Dow Jones Industrial Average ETF" },
  RTY: { symbol: "IWM", name: "iShares Russell 2000 ETF" },
  ZB: { symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF" },
  ZN: { symbol: "IEF", name: "iShares 7-10 Year Treasury Bond ETF" },
  "6E": { symbol: "FXE", name: "Invesco CurrencyShares Euro Trust" },
  "6J": { symbol: "FXY", name: "Invesco CurrencyShares Japanese Yen Trust" },
  "6B": { symbol: "FXB", name: "Invesco CurrencyShares British Pound Sterling Trust" },
  BTC: { symbol: "IBIT", name: "iShares Bitcoin Trust" },
  ETH: { symbol: "ETHA", name: "iShares Ethereum Trust" },
};

const MONTH_CODE_CONTRACT = /^([A-Z0-9]{1,3}?)[FGHJKMNQUVXZ]\d{1,4}$/;

/** The futures root a symbol names: GC=F, GCZ26 and the generic GC1 all give GC. `known` says which roots a bare contract may carry. */
function futuresRoot(symbol: string, known: (root: string) => boolean = (root) => !!FUTURES_ALTERNATIVES[root]): string | null {
  const ticker = symbol.trim().toUpperCase().replace(/[.:][A-Z]+$/, "");
  if (ticker.endsWith("=F")) {
    const body = ticker.slice(0, -2);
    return known(body) ? body : MONTH_CODE_CONTRACT.exec(body)?.[1] ?? body;
  }
  const generic = parseFuturesGeneric(ticker);
  if (generic) return generic.root;
  const contract = MONTH_CODE_CONTRACT.exec(ticker)?.[1];
  return contract && known(contract) ? contract : null;
}

/** The listed fund whose options stand in for an instrument with no chain, if there is one. */
export function listedOptionsAlternative(symbol: string): ListedOptionsAlternative | null {
  const root = futuresRoot(symbol);
  return root ? FUTURES_ALTERNATIVES[root] ?? null : null;
}

/** Whether an options request failed because nothing lists options on the instrument. */
export function isOptionsUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\boptions provider available for\b/i.test(message);
}

/** "Options are not available for GC=F.": the dead end itself, before any follow-up. */
export function optionsUnavailableTitle(symbol: string): string {
  return `Options are not available for ${symbol.trim().toUpperCase()}.`;
}

/**
 * The coins whose options Gloom Cloud serves, from Deribit, as BTC-USD and
 * ETH-USD: the standard options path (options, OMON, OPX, OVDV).
 */
const COIN_OPTION_UNDERLYINGS: Readonly<Record<string, string>> = { BTC: "BTC-USD", ETH: "ETH-USD" };

/** BTC-USD or ETH-USD for a coin pair whose options are listed (on the coin board or bare); null otherwise. */
export function listedCoinOptions(symbol: string): string | null {
  const parsed = parsePublicTickerKey(symbol.trim().toUpperCase());
  if (!isRoundTheClockCoin(parsed.symbol, parsed.exchange)) return null;
  const pair = /^([A-Z0-9]+)-USD$/.exec(parsed.symbol)?.[1];
  return pair ? COIN_OPTION_UNDERLYINGS[pair] ?? null : null;
}

/** A coin (SOL-USD, DOGE-USD) nothing lists options on: only BTC and ETH have them. */
export function isCoinWithoutOptions(symbol: string): boolean {
  const parsed = parsePublicTickerKey(symbol.trim().toUpperCase());
  return isRoundTheClockCoin(parsed.symbol, parsed.exchange) && listedCoinOptions(symbol) == null;
}

/**
 * What exists instead for a coin without options, worded for the CLI:
 * BTC and ETH options, and the bitcoin-linked US listings with their own,
 * each as the command that reads it (`options`, or `fn OPX`).
 */
export function coinOptionsAlternativesText(command = "options"): string {
  const run = (symbol: string) => `gloomberb ${command} ${symbol}`;
  return `Listed crypto options cover BTC and ETH: ${run("BTC-USD")}, ${run("ETH-USD")}.`
    + ` Bitcoin-linked US listings have their own: ${run("IBIT")}.`;
}

/** The same for a pane, which has no commands to give. */
export const COIN_OPTIONS_HINT = "Listed crypto options cover BTC-USD and ETH-USD; bitcoin-linked US funds such as IBIT list their own.";

/**
 * An options function's `refuseSymbol`: a coin nothing lists options on
 * (SOL-USD) is answered before any request, with what exists instead.
 */
export function coinWithoutOptionsRefusal(code: string) {
  return (key: string): { message: string; details: string } | null => isCoinWithoutOptions(key)
    ? { message: optionsUnavailableTitle(parsePublicTickerKey(key.trim().toUpperCase()).symbol), details: coinOptionsAlternativesText(`fn ${code}`) }
    : null;
}

/**
 * A CLI options function's `symbolAlias` (`gloomberb fn OPX BTC`, `shot`): a
 * bare BTC or ETH is read as the coin, with a note naming the Grayscale fund's
 * listing (BTC:ARCA) for its own options (`code` is the function, OPX). The
 * command bar and panes keep a bare BTC as the fund, as everywhere else.
 */
export function coinOptionsAlias(code: string) {
  return (typed: string): { symbol: string; note: string } | null => {
    const key = typed.trim().toUpperCase();
    const pair = COIN_OPTION_UNDERLYINGS[key];
    return pair ? { symbol: pair, note: `${key} read as ${pair}, the coin's options. For the US fund that trades as ${key}: gloomberb fn ${code} ${key}:ARCA` } : null;
  };
}

/**
 * The CME currency futures, each as the pair it settles on, in the order the
 * pair is quoted: 6E is EUR/USD, 6J USD/JPY. No chain of options on any of
 * them is served here, as none is on the spot pair.
 */
const FX_FUTURES_PAIRS: Readonly<Record<string, string>> = {
  "6E": "EURUSD", "6J": "USDJPY", "6B": "GBPUSD", "6A": "AUDUSD", "6C": "USDCAD", "6S": "USDCHF", "6N": "NZDUSD", "6M": "USDMXN",
};

/** The US-listed currency funds whose options stand in for an FX pair's volatility, by the currency they hold. */
const FX_VOL_FUNDS: Readonly<Record<string, string>> = { EUR: "FXE", JPY: "FXY", GBP: "FXB" };
/** The fund that holds the dollar against a basket, for a pair none of the single-currency funds holds. */
const DOLLAR_FUND = "UUP";
const FX_VOL_FUND_LIST = [...Object.values(FX_VOL_FUNDS), DOLLAR_FUND];

/** The pair a symbol is: a spot pair in any spelling (EURUSD=X, EUR/USD), or a currency future (6E=F, 6EZ26, 6E1) as the pair it settles on; null for anything else. */
export function fxVolatilityPair(symbol: string, exchange?: string): string | null {
  const spot = currencyPairCode(symbol, exchange);
  // Metals quoted against a currency (XAUUSD=X) are no currency pair.
  if (spot) return isCurrencyCode(spot.slice(0, 3)) && isCurrencyCode(spot.slice(3)) ? spot : null;
  const root = futuresRoot(symbol, (candidate) => !!FX_FUTURES_PAIRS[candidate]);
  return root ? FX_FUTURES_PAIRS[root] ?? null : null;
}

/**
 * The listed fund that stands in for an FX pair's volatility: the one that
 * holds the pair's euro, yen or pound, else the dollar index fund.
 */
function fxVolatilityFunds(pair: string): string[] {
  const held = [pair.slice(0, 3), pair.slice(3)].map((code) => FX_VOL_FUNDS[code]).filter((fund): fund is string => !!fund);
  return held.length > 0 ? held : FX_VOL_FUND_LIST;
}

/**
 * What exists instead for the volatility of an FX pair or currency future,
 * worded as one line for the CLI: OTC FX volatility is not served, the
 * currency funds' options are the nearest listed thing (the one that holds
 * the pair's euro, yen or pound, else any of them), and HVT reads the pair's
 * realized volatility. Null for anything that is no FX pair. `code` is the
 * function asked (OVDV), `symbol` as typed.
 */
function fxVolatilityAnswer(code: string, symbol: string): string | null {
  const pair = fxVolatilityPair(symbol);
  if (!pair) return null;
  const typed = symbol.trim().toUpperCase();
  const funds = fxVolatilityFunds(pair);
  // VCA screens every fund; the others read the pair's own, or the dollar's when it has none.
  const read = code === "VCA" ? funds.join(",") : funds === FX_VOL_FUND_LIST ? DOLLAR_FUND : funds[0]!;
  return `OTC FX volatility is not covered for ${typed}. Currency-ETF options are the listed proxy: `
    + `${funds.join(", ")} (gloom fn ${code} ${read}). Realized volatility: gloom fn HVT ${typed}.`;
}

/**
 * The same for a pane, which has no commands to give: what is not covered,
 * the funds whose options stand in, and HVT for realized volatility.
 */
export function fxVolatilityNote(symbol: string, exchange?: string): string | null {
  const pair = fxVolatilityPair(symbol, exchange);
  if (!pair) return null;
  return `OTC FX volatility is not covered for ${symbol.trim().toUpperCase()}. Currency-ETF options are the listed proxy: `
    + `${fxVolatilityFunds(pair).join(", ")}. HVT shows the pair's realized volatility.`;
}

/**
 * A volatility function's `refuseSymbol` for FX (OVDV, VCA, HIVG): an FX pair
 * or currency future is answered before any request, with one line saying
 * OTC FX volatility is not covered and what to read instead.
 */
export function fxVolatilityRefusal(code: string) {
  return (key: string): { message: string; details?: string } | null => {
    const message = fxVolatilityAnswer(code, key);
    return message ? { message } : null;
  };
}
