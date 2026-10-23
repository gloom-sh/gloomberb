import { futuresContractByCode } from "../market-data/futures-board";
import { getListingSymbol, hongKongListingCode, tickerHasListingSuffix } from "../sources/listing-symbols";
import { isCurrencyCode } from "../utils/currency-pair";
import { isKnownExchangeCode, isUsListingExchange } from "../utils/exchanges";

/**
 * A listing written the way a market data terminal names it, read as the
 * listing it is. Reuters codes put the venue after a dot (WFC.N for the New
 * York Stock Exchange, AAPL.O or AAPL.OQ for Nasdaq) and a share class in
 * lower case before it (BRKb.N). Bloomberg writes the symbol, the market and
 * the asset class, its yellow key: JPM US Equity (the US composite), VOD LN
 * Equity (London), 7203 JP (Tokyo, the key left off), SPX Index, EURUSD
 * Curncy, CL1 Comdty. The suffixes of listings abroad (VOD.L, 7203.T, RY.TO,
 * 0700.HK) and US share classes (BRK.B) are not codes; they read as before.
 */
export interface TerminalListingCode {
  /** The code as typed, trimmed: `WFC.N`, `JPM US Equity`. */
  typed: string;
  /** The symbol, with a US share class after a dot: `WFC`, `BRK.B`, `0700`, `^GSPC`. */
  symbol: string;
  /** The canonical code of the venue the code names; "" for Bloomberg's US composite and for a code that names no venue (SPX Index). */
  exchange: string;
  /** `WFC:NYSE`, `VOD:LSE`, or `JPM` for the US composite. */
  key: string;
  /** Which terminal writes it so: a Bloomberg code is words, which a fund's name can also be. */
  terminal: "reuters" | "bloomberg";
  /** Bloomberg's market code, in capitals (`LN`); absent for a Reuters code and an index, a currency or a future. */
  market?: string;
  /** Bloomberg's yellow key, when the code is one: typed, or the Equity a market code implies. */
  yellowKey?: BloombergYellowKey;
  /**
   * Further listings the code can name, tried in order when search does not
   * list the first: VOLV.B:SFB for `VOLVB SS` (Bloomberg glues a Nordic class
   * on), RY:TSXV for `RY CN` (Canada is Toronto, then the Venture exchange).
   */
  alternatives?: readonly TerminalListing[];
}

export interface TerminalListing {
  symbol: string;
  exchange: string;
  key: string;
}

/** The yellow keys the terminal reads. Govt, Corp, Mtge, Muni, Pfd and M-Mkt name securities no source here quotes. */
type BloombergYellowKey = "Equity" | "Index" | "Curncy" | "Comdty";

const YELLOW_KEYS: Readonly<Record<string, BloombergYellowKey>> = {
  equity: "Equity", index: "Index", curncy: "Curncy", comdty: "Comdty",
};

interface BloombergMarket {
  /**
   * The venues, as the shared exchange-notation table's canonical codes, in
   * the order tried; "" is a US listing, named by its bare symbol.
   */
  venues: readonly string[];
  /**
   * How a local symbol differs from Bloomberg's there: a Nordic share class
   * glued on (VOLVB is VOLV.B), a code without its leading zeros (700 is
   * 0700), the China composite's venue read from the code (6 is Shanghai).
   */
  local?: "nordic-class" | "pad4" | "china";
  /** Where Bloomberg's ticker is not the venue's own code (Maybank is MAY MK, 1155 on Bursa): what to type instead. */
  hint?: string;
  /** A market no source here quotes, named for the refusal: the Philippine Stock Exchange. Its `venues` are empty. */
  name?: string;
}

const at = (...venues: string[]): BloombergMarket => ({ venues });
const US_COMPOSITE = at("");

/**
 * Bloomberg's market codes, checked against OpenFIGI (Bloomberg's open
 * symbology) with a known listing on each venue. Every venue is one the
 * exchange-notation table names, or the code search lists a venue by where
 * the table has none yet (ISE, JAKARTA, SET, BURSAMY); a parity test holds
 * both, so a code reads as the same venue a typed `SYM:EXCH` does.
 */
export const BLOOMBERG_MARKETS: Readonly<Record<string, BloombergMarket>> = {
  US: US_COMPOSITE,
  UV: US_COMPOSITE,
  UN: at("NYSE"),
  UW: at("NASDAQ"),
  UQ: at("NASDAQ"),
  UR: at("NASDAQ"),
  UA: at("AMEX"),
  UP: at("ARCA"),
  UF: at("BATS"),
  LN: at("LSE"),
  GY: at("XETRA"),
  GR: at("XETRA"),
  GF: at("FWB2"),
  FP: at("EPA"),
  NA: at("AMS"),
  BB: at("BRU"),
  PL: at("LIS"),
  ID: at("ISE"),
  IM: at("BIT"),
  SM: at("MCE"),
  SW: at("SWX"),
  SE: at("SWX"),
  SS: { venues: ["SFB"], local: "nordic-class" },
  DC: { venues: ["CPH"], local: "nordic-class" },
  FH: { venues: ["HEL"], local: "nordic-class" },
  NO: { venues: ["OSL"], local: "nordic-class" },
  AV: at("VIE"),
  PW: at("WSE"),
  CP: at("PSE"),
  JT: at("JPX"),
  JP: at("JPX"),
  HK: { venues: ["HKEX"], local: "pad4" },
  CH: { venues: ["SSE", "SZSE"], local: "china" },
  CG: at("SSE"),
  CS: at("SZSE"),
  KS: at("KRX"),
  KQ: at("KOSDAQ"),
  TT: at("TWSE", "TPEX"),
  IN: at("NSE"),
  IS: at("NSE"),
  IB: at("BSE"),
  SP: { venues: ["SGX"], hint: "Bloomberg and SGX codes differ there: type the SGX code, such as D05 SP for DBS." },
  MK: { venues: ["BURSAMY"], hint: "Bloomberg and Bursa Malaysia codes differ there: type the Bursa code, such as 1155 MK for Maybank." },
  IJ: at("JAKARTA"),
  TB: at("SET"),
  PM: { venues: [], name: "Philippine Stock Exchange" },
  AU: at("ASX"),
  NZ: at("NZX"),
  CN: at("TSX", "TSXV"),
  CT: at("TSX"),
  CV: at("TSXV"),
  MM: at("BMV"),
  BZ: at("B3"),
  BS: at("B3"),
  AR: at("BYMA"),
  SJ: at("JSE"),
  IT: at("TASE"),
};

/** Bloomberg's index tickers the quote sources carry, by the symbol each is quoted as. */
const BLOOMBERG_INDICES: Readonly<Record<string, string>> = {
  SPX: "^GSPC", INDU: "^DJI", CCMP: "^IXIC", NDX: "^NDX", RTY: "^RUT", VIX: "^VIX",
  UKX: "^FTSE", DAX: "^GDAXI", CAC: "^FCHI", SX5E: "^STOXX50E", SMI: "^SSMI", AEX: "^AEX", IBEX: "^IBEX",
  NKY: "^N225", HSI: "^HSI", KOSPI: "^KS11", TWSE: "^TWII", SENSEX: "^BSESN", NIFTY: "^NSEI", FSSTI: "^STI",
  AS51: "^AXJO", SPTSX: "^GSPTSE", MEXBOL: "^MXX", IBOV: "^BVSP", DXY: "DX-Y.NYB",
  USGG5YR: "^FVX", USGG10YR: "^TNX", USGG30YR: "^TYX",
};

/** Index and volatility futures Bloomberg writes with the Index key (ES1 Index, DM1 Index, UX1 Index), by the root quoted here. */
const BLOOMBERG_INDEX_FUTURE_ROOTS: Readonly<Record<string, string>> = {
  ES: "ES", NQ: "NQ", RTY: "RTY", DM: "YM", YM: "YM", UX: "VX", VX: "VX",
};

/** Futures roots Bloomberg spells its own way (CO is Brent); the quote service reads these as its own roots. */
const BLOOMBERG_FUTURES_ALIASES: ReadonlySet<string> = new Set([
  "TY", "US", "FV", "TU", "WN", "DM", "FF", "SFR", "CO", "XB", "LC", "LH", "FC", "SM", "BO", "KW",
]);

/** "EUR Curncy" is the dollar rate in market convention: these as XXXUSD, every other currency as USDXXX. */
const DOLLAR_BASE_CURRENCIES: ReadonlySet<string> = new Set(["EUR", "GBP", "AUD", "NZD"]);

/** Bloomberg writes bitcoin as XBT. */
const BLOOMBERG_CRYPTO: Readonly<Record<string, string>> = { XBT: "BTC-USD", XBTUSD: "BTC-USD" };

const REUTERS_VENUES: Record<string, string> = { N: "NYSE", O: "NASDAQ", OQ: "NASDAQ" };

/** `WFC.N`, `BRKb.N` (class B, in lower case as Reuters writes it), `wfc.n`, `AAPL.OQ`. */
const REUTERS_CODE = /^([A-Za-z]{1,6})\.(N|O|OQ)$/i;
/** A root in capitals with one lower-case letter after it: the letter is the share class (BRKb). */
const REUTERS_CLASS = /^([A-Z]{1,5})([a-z])$/;
/** A Bloomberg ticker: letters and digits, a share class after a slash (BRK/B, BT/A), or BP/ as BP trades. */
const BLOOMBERG_ROOT = /^([A-Za-z0-9]{1,12})(?:\/([A-Za-z]{1,2})?)?$/;

/** A Bloomberg ticker's root and share class; a slash after one letter is a ratio or an abbreviation (P/E, N/A, Y/Y), never a class. */
function bloombergRoot(word: string): { ticker: string; shareClass: string | undefined } | null {
  const root = BLOOMBERG_ROOT.exec(word);
  if (!root || (word.includes("/") && root[1]!.length < 2)) return null;
  return { ticker: root[1]!, shareClass: root[2] };
}
/** A market code: two letters. */
const MARKET_CODE = /^[A-Za-z]{2}$/;

function keyOf(symbol: string, exchange: string): TerminalListing {
  return { symbol, exchange, key: exchange ? `${symbol}:${exchange}` : symbol };
}

/** The parts of a code written the Bloomberg way, read or not: `VOD LN Equity` is VOD, LN, Equity. */
interface BloombergParts {
  typed: string;
  /** The code's words before the yellow key. */
  parts: string[];
  yellowKey: BloombergYellowKey | null;
}

function bloombergParts(typed: string): BloombergParts | null {
  const words = typed.split(" ");
  if (words.length < 2 || words.length > 3) return null;
  const yellowKey = YELLOW_KEYS[words.at(-1)!.toLowerCase()] ?? null;
  const parts = yellowKey ? words.slice(0, -1) : words;
  return { typed, parts, yellowKey };
}

/**
 * Whether a code with no yellow key is written as one: the root and the
 * market in capitals (`VOD LN`, `7203 JP`). In lower case the same words
 * are a name or a phrase (`apple us`, `nestle sw`), as they were.
 */
function writtenAsCode(typed: string): boolean {
  return !/\p{Ll}/u.test(typed);
}

/** The local spellings of a Bloomberg equity ticker on its market, in the order tried. */
function equityListings(root: string, shareClass: string | undefined, market: BloombergMarket): TerminalListing[] {
  const ticker = root.toUpperCase();
  // Shanghai's codes start with 6 (shares), 5 (funds) or 9 (B shares); Shenzhen's with 0, 1, 2 or 3.
  const venues = market.local === "china" ? [/^[569]/.test(ticker) ? "SSE" : "SZSE"] : market.venues;
  return venues.flatMap((venue) => {
    // A share class reads as a broker writes it in the US (BRK-B, as `BRK/B` does) and after a dot abroad (BT.A), as search lists those.
    if (shareClass) return [keyOf(`${ticker}${!venue || isUsListingExchange(venue) ? "-" : "."}${shareClass.toUpperCase()}`, venue)];
    if (market.local === "pad4") return [keyOf(hongKongListingCode(ticker, venue), venue)];
    const spellings = [keyOf(ticker, venue)];
    // VOLVB is VOLV.B there; ABB, SAND and NOKIA end in a letter too, so the code as written goes first.
    const nordic = market.local === "nordic-class" ? /^([A-Z0-9]{2,})([A-D])$/.exec(ticker) : null;
    if (nordic) spellings.push(keyOf(`${nordic[1]}.${nordic[2]}`, venue));
    return spellings;
  }).filter((listing, index, all) => all.findIndex((other) => other.key === listing.key) === index);
}

function readBloombergEquity({ typed, parts, yellowKey }: BloombergParts): TerminalListingCode | null {
  if (parts.length !== 2) return null;
  const [rootWord, marketWord] = parts as [string, string];
  const root = bloombergRoot(rootWord);
  const code = marketWord.toUpperCase();
  const market = BLOOMBERG_MARKETS[code];
  if (!root || !market || !MARKET_CODE.test(marketWord)) return null;
  // Without its yellow key a code is read only as written in capitals.
  if (!yellowKey && !writtenAsCode(typed)) return null;
  const [first, ...alternatives] = equityListings(root.ticker, root.shareClass, market);
  if (!first) return null;
  return {
    typed, ...first, terminal: "bloomberg", market: code, yellowKey: "Equity",
    ...alternatives.length > 0 ? { alternatives } : {},
  };
}

/** `SPX Index`, and an index future Bloomberg keys as one: `ES1 Index`. */
function readBloombergIndex(typed: string, code: string): TerminalListingCode | null {
  const index = BLOOMBERG_INDICES[code];
  if (index) return { typed, ...keyOf(index, ""), terminal: "bloomberg", yellowKey: "Index" };
  const future = /^([A-Z]{2,3})(\d{1,2})$/.exec(code);
  const root = future ? BLOOMBERG_INDEX_FUTURE_ROOTS[future[1]!] : undefined;
  return root ? genericFuture(typed, root, future![2]!, "Index") : null;
}

/** `EURUSD Curncy`, `JPY Curncy` (the dollar rate in market convention: USDJPY), `XBT Curncy`. */
function readBloombergCurrency(typed: string, code: string): TerminalListingCode | null {
  const crypto = BLOOMBERG_CRYPTO[code];
  if (crypto) return { typed, ...keyOf(crypto, ""), terminal: "bloomberg", yellowKey: "Curncy" };
  const [base, quote] = /^[A-Z]{6}$/.test(code) ? [code.slice(0, 3), code.slice(3)]
    : /^[A-Z]{3}$/.test(code) && code !== "USD" ? DOLLAR_BASE_CURRENCIES.has(code) ? [code, "USD"] : ["USD", code]
      : [null, null];
  if (!base || !quote || base === quote || !isCurrencyCode(base) || !isCurrencyCode(quote)) return null;
  return { typed, ...keyOf(`${base}${quote}=X`, ""), terminal: "bloomberg", yellowKey: "Curncy" };
}

/**
 * A Bloomberg generic future, `CL1 Comdty`, as the generic the quote service
 * rolls at expiry the way Bloomberg's do (CL1E). A dated contract (CLZ6) is
 * not read: no source here quotes one by that name.
 */
function readBloombergComdty(typed: string, code: string): TerminalListingCode | null {
  const generic = /^([A-Z]{1,3})(\d{1,2})$/.exec(code);
  if (!generic) return null;
  const root = generic[1]!;
  return futuresContractByCode(root) || BLOOMBERG_FUTURES_ALIASES.has(root) ? genericFuture(typed, root, generic[2]!, "Comdty") : null;
}

function genericFuture(typed: string, root: string, position: string, yellowKey: BloombergYellowKey): TerminalListingCode | null {
  if (position.startsWith("0")) return null;
  return { typed, ...keyOf(`${root}${position}E`, ""), terminal: "bloomberg", yellowKey };
}

function readBloombergCode(typed: string): TerminalListingCode | null {
  const code = bloombergParts(typed);
  if (!code) return null;
  if (code.yellowKey === "Equity" || !code.yellowKey) return readBloombergEquity(code);
  if (code.parts.length !== 1) return null;
  const word = code.parts[0]!.toUpperCase();
  if (code.yellowKey === "Index") return readBloombergIndex(typed, word);
  if (code.yellowKey === "Curncy") return readBloombergCurrency(typed, word);
  return readBloombergComdty(typed, word);
}

function listing(
  typed: string,
  root: string,
  shareClass: string | undefined,
  exchange: string,
  terminal: TerminalListingCode["terminal"],
): TerminalListingCode {
  const symbol = `${root.toUpperCase()}${shareClass ? `.${shareClass.toUpperCase()}` : ""}`;
  return { typed, ...keyOf(symbol, exchange), terminal };
}

function readReutersCode(typed: string): TerminalListingCode | null {
  const reuters = REUTERS_CODE.exec(typed);
  if (!reuters) return null;
  // Typed all in lower case (wfc.n), the last letter is part of the symbol, not a class.
  const shareClass = REUTERS_CLASS.exec(reuters[1]!);
  const exchange = REUTERS_VENUES[reuters[2]!.toUpperCase()]!;
  return shareClass
    ? listing(typed, shareClass[1]!, shareClass[2], exchange, "reuters")
    : listing(typed, reuters[1]!, undefined, exchange, "reuters");
}

function normalizeTyped(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * The one reader of a terminal's code: Reuters' (WFC.N) and Bloomberg's
 * (`VOD LN`, `JPM US Equity`, `SPX Index`, `EURUSD Curncy`, `CL1 Comdty`).
 * A Bloomberg equity code without its yellow key is read only in capitals.
 * Null for anything else, and for a market code no venue here answers to
 * (`unknownBloombergMarket` says which).
 */
export function readTerminalListingCode(raw: string): TerminalListingCode | null {
  const typed = normalizeTyped(raw);
  return readReutersCode(typed) ?? readBloombergCode(typed);
}

/** `VOD LN` as typed, an `Equity` it left off implied: what a code's suggestion names. */
export interface UnknownBloombergMarket {
  typed: string;
  /** The ticker before the market code, in capitals: AAPL. */
  symbol: string;
  /** The market code no venue answers to, in capitals: GP. */
  market: string;
  /** Whether the code carried its yellow key, so its words cannot be two symbols. */
  keyed: boolean;
  /** The market's name when the code is a real one no source here quotes (PM, the Philippine Stock Exchange). */
  unquoted?: string;
}

/**
 * A line written as a Bloomberg equity code whose market code no venue here
 * answers to (`AAPL GP`, `KO PG`, `AAPL ZZ Equity`, `SM PM`): one entry,
 * refused with a suggestion unless it is a company's name, never two
 * symbols. Without the yellow key only capitals count, so `Apple Co` stays a
 * name. Null for anything else.
 */
export function unknownBloombergMarket(raw: string): UnknownBloombergMarket | null {
  const typed = normalizeTyped(raw);
  const code = bloombergParts(typed);
  if (!code || code.parts.length !== 2 || (code.yellowKey && code.yellowKey !== "Equity")) return null;
  const [rootWord, marketWord] = code.parts as [string, string];
  const market = BLOOMBERG_MARKETS[marketWord.toUpperCase()];
  if (!bloombergRoot(rootWord) || !MARKET_CODE.test(marketWord) || (market && market.venues.length > 0)) return null;
  if (!code.yellowKey && !writtenAsCode(typed)) return null;
  return {
    typed, symbol: rootWord.toUpperCase(), market: marketWord.toUpperCase(), keyed: !!code.yellowKey,
    ...market?.name ? { unquoted: market.name } : {},
  };
}

/** What to type instead where Bloomberg's ticker is not the venue's own code (MK, SP); null elsewhere. */
export function bloombergMarketHint(market: string | undefined): string | null {
  return (market && BLOOMBERG_MARKETS[market]?.hint) || null;
}

/** Whether the venue a code names is one the exchange table has no entry for yet (JAKARTA), so search alone can say what is listed there. */
export function isSearchOnlyVenue(exchange: string): boolean {
  return !!exchange && !isKnownExchangeCode(exchange);
}

/**
 * Company legal forms written after a name. Two words ending in one (`SAP SE`,
 * `SIEMENS AG`, `NESTLE SA`) look like a Bloomberg code, and SE is also
 * SIX Swiss's market code, so the name is looked up first.
 */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "AG", "SE", "SA", "NV", "AB", "AS", "BV", "KK", "OY", "CO", "PLC", "ASA", "OYJ", "SPA", "LTD", "INC", "CORP", "LLC",
  "GMBH", "KGAA", "BHD", "TBK", "PCL",
]);

/** Two words, the second a company's legal form (`SAP SE`, `VOLVO AB`): a name to look up before reading it as a code. */
export function endsInLegalForm(raw: string): boolean {
  const words = normalizeTyped(raw).split(" ");
  return words.length === 2 && LEGAL_FORMS.has(words[1]!.toUpperCase());
}

/** Bloomberg's code for each venue, the first the table lists for it: US for every US exchange, LN for LSE. */
const BLOOMBERG_CODE_OF_VENUE: ReadonlyMap<string, string> = (() => {
  const codes = new Map<string, string>();
  for (const [code, market] of Object.entries(BLOOMBERG_MARKETS)) {
    if (market.local === "china") continue;
    for (const venue of market.venues) if (venue && !codes.has(venue)) codes.set(venue, code);
  }
  return codes;
})();

/** `AAPL US` for AAPL on NASDAQ, `VOD LN` for VOD on LSE: a listing as Bloomberg writes it; null where no code here names its venue. */
export function bloombergCodeOf(symbol: string, exchange: string): string | null {
  const code = isUsListingExchange(exchange) ? "US" : BLOOMBERG_CODE_OF_VENUE.get(exchange);
  return code ? `${symbol} ${code}` : null;
}

/** A symbol typed nearly as a listing's: what was typed and the working form it reads as. */
export interface NearMissListing {
  typed: string;
  /** The working spelling: 0700.HK, 6758.T, BRK-B. */
  symbol: string;
}

/** `BRK/B`: a US share class after a slash, as a broker writes it. One letter before the slash is a ratio or an abbreviation (P/E, N/A). */
const SLASH_CLASS = /^([A-Z]{2,5})\/([A-Z])$/;
/** `700.HK`: a Hong Kong code without its leading zeros. */
const SHORT_HONG_KONG = /^(\d{1,3})\.HK$/;
/** `6758.JP`, `MC.FP`: a symbol with a Bloomberg market code where a listing suffix goes. */
const MARKET_SUFFIX = /^([A-Z0-9]{1,10})\.([A-Z]{2})$/;
/**
 * The market codes read after a dot: those no listing suffix uses and no one
 * writes for another country. SE (Swiss, Sweden's ISO code), IT (Tel Aviv,
 * Italy's), PL (Lisbon, Poland's), GR (Germany, Greece's) and the like stay
 * as typed, and so does UN, which a Canadian unit trust writes (REI.UN).
 */
const MARKET_SUFFIX_CODES: ReadonlySet<string> = new Set([
  "JP", "JT", "LN", "FP", "GY", "NA", "IM", "SM", "AU", "TT", "IN", "IB", "FH", "DC", "NO", "AV", "PW", "BB", "SJ", "MM", "BZ", "CT", "CV",
]);

/**
 * A symbol written nearly as a listing is (`700.HK`, `6758.JP`, `BRK/B`),
 * read as the working form (`0700.HK`, `6758.T`, `BRK-B`). A Bloomberg market
 * code after the dot is that market's listing suffix (`MC.FP` is `MC.PA`),
 * `MARKET_SUFFIX_CODES` only, so `600519.SS` stays Shanghai. Null for
 * anything else.
 */
export function readNearMissListing(raw: string): NearMissListing | null {
  const typed = raw.trim();
  const upper = typed.toUpperCase();
  const slash = SLASH_CLASS.exec(upper);
  if (slash) return { typed, symbol: `${slash[1]}-${slash[2]}` };
  const hongKong = SHORT_HONG_KONG.exec(upper);
  if (hongKong) return { typed, symbol: `${hongKong[1]!.padStart(4, "0")}.HK` };
  const suffixed = MARKET_SUFFIX.exec(upper);
  if (!suffixed || !MARKET_SUFFIX_CODES.has(suffixed[2]!) || tickerHasListingSuffix(upper)) return null;
  const venue = BLOOMBERG_MARKETS[suffixed[2]!]!.venues[0]!;
  const symbol = getListingSymbol(suffixed[1]!, venue);
  return tickerHasListingSuffix(symbol) ? { typed, symbol } : null;
}

/** `Read WFC.N as WFC:NYSE.`, for a command's warnings. */
export function terminalCodeReadAs(code: Pick<TerminalListingCode, "typed" | "key">): string {
  return `Read ${/\s/.test(code.typed) ? `"${code.typed}"` : code.typed} as ${code.key}.`;
}
