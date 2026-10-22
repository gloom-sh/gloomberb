import { isRoundTheClockCoin } from "../utils/crypto-pair";
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
  BTC: { symbol: "IBIT", name: "iShares Bitcoin Trust" },
  ETH: { symbol: "ETHA", name: "iShares Ethereum Trust" },
};

const MONTH_CODE_CONTRACT = /^([A-Z0-9]{1,3}?)[FGHJKMNQUVXZ]\d{1,4}$/;

/** The futures root a symbol names: GC=F, GCZ26 and the generic GC1 all give GC. */
function futuresRoot(symbol: string): string | null {
  const ticker = symbol.trim().toUpperCase().replace(/[.:][A-Z]+$/, "");
  if (ticker.endsWith("=F")) {
    const body = ticker.slice(0, -2);
    return FUTURES_ALTERNATIVES[body] ? body : MONTH_CODE_CONTRACT.exec(body)?.[1] ?? body;
  }
  const generic = parseFuturesGeneric(ticker);
  if (generic) return generic.root;
  const contract = MONTH_CODE_CONTRACT.exec(ticker)?.[1];
  return contract && FUTURES_ALTERNATIVES[contract] ? contract : null;
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
 * A bare BTC or ETH typed into an options function is the coin (BTC-USD),
 * whose options are the ones asked about; the Grayscale mini trusts listed
 * as BTC and ETH stay reachable by their listing (BTC:ARCX). Anything else
 * is returned as it was.
 */
export function coinOptionsSymbol(symbol: string): string {
  const key = symbol.trim().toUpperCase();
  return COIN_OPTION_UNDERLYINGS[key] ?? symbol;
}

/**
 * An options function's `symbolAlias`: a bare BTC or ETH is read as the coin,
 * with a note naming the fund's listing for its own options (`code` is the
 * function, OPX).
 */
export function coinOptionsAlias(code: string) {
  return (typed: string): { symbol: string; note: string } | null => {
    const key = typed.trim().toUpperCase();
    const pair = COIN_OPTION_UNDERLYINGS[key];
    return pair ? { symbol: pair, note: `${key} read as ${pair}, the coin's options. For the US fund that trades as ${key}: gloomberb fn ${code} ${key}:ARCA` } : null;
  };
}
