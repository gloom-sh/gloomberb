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
