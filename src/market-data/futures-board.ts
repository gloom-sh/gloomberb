export type FuturesSector =
  | "equity-index"
  | "equity-sectors"
  | "rates"
  | "energy"
  | "metals"
  | "agriculture"
  | "livestock"
  | "currencies";

export interface FuturesContract {
  /** Continuous front-month symbol. */
  symbol: string;
  /** Exchange code traders quote, e.g. ES. */
  code: string;
  name: string;
  sector: FuturesSector;
  /**
   * Minimum price increment of the outright contract. It is the display
   * precision: silver ticks at $0.005, so rendering it with two decimals
   * collapses every tick. Rates contracts leave this unset because their
   * 32nd-based ticks (down to 1/256) do not map to a readable decimal count.
   */
  tick?: number;
  /** Exchange suffix of the root's listed contracts: CLZ26.NYM. */
  venue: "CME" | "CBT" | "NYM" | "CMX" | "NYB";
  /** Lists a contract for every calendar month. */
  everyMonth?: true;
  /**
   * What a price counts where the server sends no contract terms for the root:
   * Dutch TTF gas quotes in euros per MWh, which a bare "EUR" does not say, and
   * live cattle in US cents per pound, where the server's "USX" does not.
   */
  unit?: string;
  /**
   * No listed security answers to the code typed alone, so a bare TTF, ZN or 6E
   * is this future wherever a symbol is typed. Codes a security also uses (NG
   * is NovaGold, CL Colgate, ZM Zoom, GC several venues' listings) leave it
   * unset: the security keeps the code and the future is its `=F` symbol.
   * Checked with `gloomberb quote <code>` signed out on 2026-10-11: each of
   * these was "Not a ticker", or for ZT and ZF a quote last updated in 2023 and
   * 2021 that search no longer lists. The sector, index and energy rows were
   * checked the same way on 2026-10-14: XAR is an ETF, XAU Goldmoney, SXI
   * Standex, SXT Sensient, RX BioSyent, EMD a closed-end fund, SOX the PHLX
   * index, and RS1, MES, MYM, M2K, MCL, MNG and HH are listed abroad.
   */
  bareCode?: true;
  /** Everyday names the board's own does not hold: oil is WTI crude, not heating or soybean oil. */
  aliases?: readonly string[];
}

/** 0.005 -> 3, 0.25 -> 2, 1 -> 0. Written for ticks, not general numbers. */
export function tickDecimals(tick: number): number {
  return tick.toFixed(10).replace(/0+$/, "").split(".")[1]?.length ?? 0;
}

/**
 * Front-month continuous contracts, every one confirmed to resolve through the
 * market backend. `DX=F` is unavailable, and the dollar
 * index is already on the world indices board as `DX-Y.NYB`.
 */
export const FUTURES_CONTRACTS: FuturesContract[] = [
  { symbol: "ES=F", code: "ES", name: "E-Mini S&P 500", sector: "equity-index", venue: "CME", tick: 0.25 },
  { symbol: "NQ=F", code: "NQ", name: "E-Mini Nasdaq 100", sector: "equity-index", venue: "CME", tick: 0.25, bareCode: true },
  { symbol: "YM=F", code: "YM", name: "E-Mini Dow", sector: "equity-index", venue: "CBT", tick: 1, bareCode: true },
  { symbol: "RTY=F", code: "RTY", name: "E-Mini Russell 2000", sector: "equity-index", venue: "CME", tick: 0.1, bareCode: true },
  { symbol: "EMD=F", code: "EMD", name: "E-Mini S&P MidCap 400", sector: "equity-index", venue: "CME", tick: 0.1 },
  { symbol: "RS1=F", code: "RS1", name: "E-Mini Russell 1000", sector: "equity-index", venue: "CME", tick: 0.1 },
  { symbol: "NKD=F", code: "NKD", name: "Nikkei 225 (USD)", sector: "equity-index", venue: "CME", tick: 5, bareCode: true },
  // Quoted in yen: the same index points, each worth 500 yen, so the server has no dollar terms for it.
  { symbol: "NIY=F", code: "NIY", name: "Nikkei 225 (Yen)", sector: "equity-index", venue: "CME", tick: 5, unit: "index points", bareCode: true },
  { symbol: "MES=F", code: "MES", name: "Micro E-Mini S&P 500", sector: "equity-index", venue: "CME", tick: 0.25 },
  { symbol: "MNQ=F", code: "MNQ", name: "Micro E-Mini Nasdaq 100", sector: "equity-index", venue: "CME", tick: 0.25, bareCode: true },
  { symbol: "MYM=F", code: "MYM", name: "Micro E-Mini Dow", sector: "equity-index", venue: "CBT", tick: 1 },
  { symbol: "M2K=F", code: "M2K", name: "Micro E-Mini Russell 2000", sector: "equity-index", venue: "CME", tick: 0.1 },

  // CME's E-mini S&P Select Sector futures (XA*) and Select Industry futures
  // (SX*), named by their S&P index: each sector followed by its industries in
  // GICS order, then the Dow Jones U.S. Real Estate future on CBOT.
  { symbol: "XAE=F", code: "XAE", name: "S&P Energy", sector: "equity-sectors", venue: "CME", tick: 0.1, bareCode: true },
  { symbol: "SXO=F", code: "SXO", name: "S&P Oil & Gas E&P", sector: "equity-sectors", venue: "CME", tick: 0.5, bareCode: true },
  { symbol: "XAB=F", code: "XAB", name: "S&P Materials", sector: "equity-sectors", venue: "CME", tick: 0.1, bareCode: true },
  { symbol: "XAI=F", code: "XAI", name: "S&P Industrial", sector: "equity-sectors", venue: "CME", tick: 0.1, bareCode: true },
  { symbol: "XAY=F", code: "XAY", name: "S&P Consumer Discretionary", sector: "equity-sectors", venue: "CME", tick: 0.1, bareCode: true },
  { symbol: "SXR=F", code: "SXR", name: "S&P Retail", sector: "equity-sectors", venue: "CME", tick: 1, bareCode: true },
  { symbol: "XAP=F", code: "XAP", name: "S&P Consumer Staples", sector: "equity-sectors", venue: "CME", tick: 0.1, bareCode: true },
  { symbol: "XAV=F", code: "XAV", name: "S&P Health Care", sector: "equity-sectors", venue: "CME", tick: 0.1, bareCode: true },
  { symbol: "SXT=F", code: "SXT", name: "S&P Biotechnology", sector: "equity-sectors", venue: "CME", tick: 1 },
  { symbol: "XAF=F", code: "XAF", name: "S&P Financial", sector: "equity-sectors", venue: "CME", tick: 0.05, bareCode: true },
  { symbol: "SXB=F", code: "SXB", name: "S&P Regional Banks", sector: "equity-sectors", venue: "CME", tick: 0.25, bareCode: true },
  { symbol: "SXI=F", code: "SXI", name: "S&P Insurance", sector: "equity-sectors", venue: "CME", tick: 0.5 },
  { symbol: "XAK=F", code: "XAK", name: "S&P Technology", sector: "equity-sectors", venue: "CME", tick: 0.1, bareCode: true },
  { symbol: "SOX=F", code: "SOX", name: "PHLX Semiconductor", sector: "equity-sectors", venue: "CME", tick: 0.5 },
  { symbol: "XAZ=F", code: "XAZ", name: "S&P Communication Services", sector: "equity-sectors", venue: "CME", tick: 0.05, bareCode: true },
  { symbol: "XAU=F", code: "XAU", name: "S&P Utilities", sector: "equity-sectors", venue: "CME", tick: 0.1 },
  { symbol: "XAR=F", code: "XAR", name: "S&P Real Estate", sector: "equity-sectors", venue: "CME", tick: 0.05 },
  { symbol: "RX=F", code: "RX", name: "Dow Jones U.S. Real Estate", sector: "equity-sectors", venue: "CBT", tick: 0.1 },

  { symbol: "ZT=F", code: "ZT", name: "2-Year T-Note", sector: "rates", venue: "CBT", bareCode: true },
  { symbol: "ZF=F", code: "ZF", name: "5-Year T-Note", sector: "rates", venue: "CBT", bareCode: true },
  { symbol: "ZN=F", code: "ZN", name: "10-Year T-Note", sector: "rates", venue: "CBT", bareCode: true },
  { symbol: "ZB=F", code: "ZB", name: "30-Year T-Bond", sector: "rates", venue: "CBT", bareCode: true },
  { symbol: "UB=F", code: "UB", name: "Ultra T-Bond", sector: "rates", venue: "CBT", bareCode: true },

  { symbol: "CL=F", code: "CL", name: "WTI Crude Oil", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.01, aliases: ["oil"] },
  { symbol: "BZ=F", code: "BZ", name: "Brent Crude Oil", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.01 },
  { symbol: "NG=F", code: "NG", name: "Natural Gas", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.001 },
  // Quoted in euros per MWh.
  { symbol: "TTF=F", code: "TTF", name: "Dutch TTF Gas", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.001, unit: "EUR / MWh", bareCode: true },
  { symbol: "RB=F", code: "RB", name: "RBOB Gasoline", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.0001 },
  { symbol: "HO=F", code: "HO", name: "Heating Oil", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.0001 },
  // Cash settled on the CL and NG final settlements.
  { symbol: "QM=F", code: "QM", name: "E-Mini Crude Oil", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.025, bareCode: true },
  { symbol: "MCL=F", code: "MCL", name: "Micro WTI Crude Oil", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.01 },
  { symbol: "QG=F", code: "QG", name: "E-Mini Natural Gas", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.005, bareCode: true },
  { symbol: "MNG=F", code: "MNG", name: "Micro Henry Hub Natural Gas", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.001 },
  { symbol: "HH=F", code: "HH", name: "Henry Hub Last Day Financial", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.001 },

  { symbol: "GC=F", code: "GC", name: "Gold", sector: "metals", venue: "CMX", tick: 0.1 },
  { symbol: "SI=F", code: "SI", name: "Silver", sector: "metals", venue: "CMX", tick: 0.005 },
  { symbol: "HG=F", code: "HG", name: "Copper", sector: "metals", venue: "CMX", tick: 0.0005 },
  { symbol: "ALI=F", code: "ALI", name: "Aluminum", sector: "metals", venue: "CMX", tick: 0.25, unit: "USD / metric ton" },
  { symbol: "PL=F", code: "PL", name: "Platinum", sector: "metals", venue: "NYM", tick: 0.1 },
  { symbol: "PA=F", code: "PA", name: "Palladium", sector: "metals", venue: "NYM", tick: 0.1 },

  // Most grains and softs quote in US cents (cocoa, soybean meal and lumber in
  // dollars); a tick is in the quote's own units.
  { symbol: "ZC=F", code: "ZC", name: "Corn", sector: "agriculture", venue: "CBT", tick: 0.25 },
  { symbol: "ZS=F", code: "ZS", name: "Soybeans", sector: "agriculture", venue: "CBT", tick: 0.25 },
  { symbol: "ZM=F", code: "ZM", name: "Soybean Meal", sector: "agriculture", venue: "CBT", tick: 0.1 },
  { symbol: "ZL=F", code: "ZL", name: "Soybean Oil", sector: "agriculture", venue: "CBT", tick: 0.01, bareCode: true },
  { symbol: "ZW=F", code: "ZW", name: "Chicago SRW Wheat", sector: "agriculture", venue: "CBT", tick: 0.25, bareCode: true },
  { symbol: "KE=F", code: "KE", name: "KC HRW Wheat", sector: "agriculture", venue: "CBT", tick: 0.25 },
  { symbol: "KC=F", code: "KC", name: "Coffee", sector: "agriculture", venue: "NYB", tick: 0.05 },
  { symbol: "SB=F", code: "SB", name: "Sugar #11", sector: "agriculture", venue: "NYB", tick: 0.01 },
  { symbol: "CC=F", code: "CC", name: "Cocoa", sector: "agriculture", venue: "NYB", tick: 1 },
  { symbol: "CT=F", code: "CT", name: "Cotton #2", sector: "agriculture", venue: "NYB", tick: 0.01, bareCode: true },
  { symbol: "OJ=F", code: "OJ", name: "Orange Juice", sector: "agriculture", venue: "NYB", tick: 0.05, unit: "US cents / lb", bareCode: true },
  { symbol: "LBR=F", code: "LBR", name: "Lumber", sector: "agriculture", venue: "CME", tick: 0.5, unit: "USD / 1,000 board ft", bareCode: true },

  // Quoted in US cents per pound.
  { symbol: "LE=F", code: "LE", name: "Live Cattle", sector: "livestock", venue: "CME", tick: 0.025, unit: "US cents / lb" },
  { symbol: "HE=F", code: "HE", name: "Lean Hogs", sector: "livestock", venue: "CME", tick: 0.025, unit: "US cents / lb" },

  { symbol: "6E=F", code: "6E", name: "Euro FX", sector: "currencies", venue: "CME", tick: 0.00005, bareCode: true },
  { symbol: "6J=F", code: "6J", name: "Japanese Yen", sector: "currencies", venue: "CME", tick: 0.0000005, bareCode: true },
  { symbol: "6B=F", code: "6B", name: "British Pound", sector: "currencies", venue: "CME", tick: 0.0001, bareCode: true },
  { symbol: "6A=F", code: "6A", name: "Australian Dollar", sector: "currencies", venue: "CME", tick: 0.00005, bareCode: true },
  { symbol: "6C=F", code: "6C", name: "Canadian Dollar", sector: "currencies", venue: "CME", tick: 0.00005, bareCode: true },
  { symbol: "6S=F", code: "6S", name: "Swiss Franc", sector: "currencies", venue: "CME", tick: 0.00005, bareCode: true },
];

export const FUTURES_SECTOR_LABELS: Record<FuturesSector, string> = {
  "equity-index": "Equity Index",
  "equity-sectors": "Equity Sectors",
  rates: "Rates",
  energy: "Energy",
  metals: "Metals",
  agriculture: "Agriculture",
  livestock: "Livestock",
  currencies: "Currencies",
};

export const FUTURES_SECTOR_ORDER: FuturesSector[] = [
  "equity-index",
  "equity-sectors",
  "rates",
  "energy",
  "metals",
  "agriculture",
  "livestock",
  "currencies",
];

export function getContractsBySector(): Map<FuturesSector, FuturesContract[]> {
  const map = new Map<FuturesSector, FuturesContract[]>();
  for (const sector of FUTURES_SECTOR_ORDER) {
    map.set(sector, FUTURES_CONTRACTS.filter((contract) => contract.sector === sector));
  }
  return map;
}

const BY_CODE: ReadonlyMap<string, FuturesContract> = new Map(FUTURES_CONTRACTS.map((contract) => [contract.code, contract]));
const BY_SYMBOL: ReadonlyMap<string, FuturesContract> = new Map(FUTURES_CONTRACTS.map((contract) => [contract.symbol, contract]));

const typed = (value: unknown) => typeof value === "string" ? value.trim().toUpperCase() : "";

/** The board row a bare code names, in any case: NG is Natural Gas whether or not a security also uses NG. */
export function futuresContractByCode(code: unknown): FuturesContract | null {
  return BY_CODE.get(typed(code)) ?? null;
}

/**
 * The board row a futures function's typed argument names, by code or
 * continuous symbol: ttf, TTF and TTF=F are Dutch TTF Gas. A typed argument
 * always means the future, so NG here is natural gas, never NovaGold.
 */
export function futuresBoardContract(value: unknown): FuturesContract | null {
  return BY_SYMBOL.get(typed(value)) ?? futuresContractByCode(value);
}

const nameWords = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The item a typed name means: every word of it starts a word of the item's
 * name ("orange juice", "sugar" for Sugar #11, "soybean" for Soybeans). Among
 * those that match, the name with the fewest other words wins, then the
 * list's order: "crude" is WTI before Brent and the micro, "yen" the Japanese
 * yen before the Nikkei quoted in yen. A name of fewer than three letters
 * matches nothing, so a slip of a code does not land on a random row.
 */
export function bestNameMatch<T>(items: readonly T[], names: (item: T) => readonly string[], value: unknown): T | null {
  const wanted = typeof value === "string" ? nameWords(value) : [];
  if (wanted.join("").length < 3) return null;
  let best: T | null = null;
  let fewest = Number.POSITIVE_INFINITY;
  for (const item of items) {
    for (const name of names(item)) {
      const have = nameWords(name);
      if (have.length >= fewest || !wanted.every((word) => have.some((part) => part.startsWith(word)))) continue;
      best = item;
      fewest = have.length;
    }
  }
  return best;
}

/**
 * The board row a commodity's name stands for, as a reader types it into a
 * futures function: cocoa, coffee, sugar, cotton, orange juice, gold, copper,
 * crude, natural gas. Codes and symbols are `futuresBoardContract`'s.
 */
export function futuresContractByName(value: unknown): FuturesContract | null {
  return bestNameMatch(FUTURES_CONTRACTS, (contract) => [contract.name, ...contract.aliases ?? []], value);
}

/**
 * The future a bare symbol typed for a security stands for: a code no listed
 * security answers to (TTF is TTF=F). Null for every other symbol, and for a
 * code a security keeps (NG), whose future is NG=F.
 */
export function bareFuturesCode(symbol: unknown): FuturesContract | null {
  const contract = futuresContractByCode(symbol);
  return contract?.bareCode ? contract : null;
}

/**
 * The board row the ticker under the cursor names, for a futures function
 * opened without an argument: its continuous symbol (NG=F) or a code no
 * security answers to (TTF). A bare code a security keeps (NG, ZM, PL) is that
 * security's, never the future's.
 */
export function futuresBoardContractForTicker(ticker: unknown): FuturesContract | null {
  return BY_SYMBOL.get(typed(ticker)) ?? bareFuturesCode(ticker);
}
