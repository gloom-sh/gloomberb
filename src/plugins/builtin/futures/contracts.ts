export type FuturesSector =
  | "equity-index"
  | "rates"
  | "energy"
  | "metals"
  | "agriculture"
  | "livestock"
  | "currencies";

export interface FuturesContract {
  /** Yahoo continuous front-month symbol. */
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
  /** Exchange suffix of the root's listed contracts on Yahoo: CLZ26.NYM. */
  venue: "CME" | "CBT" | "NYM" | "CMX" | "NYB";
  /** Lists a contract for every calendar month. */
  everyMonth?: true;
  /** False where the contract curve (CTM) does not cover the root yet. */
  curve?: false;
}

/** 0.005 -> 3, 0.25 -> 2, 1 -> 0. Written for ticks, not general numbers. */
export function tickDecimals(tick: number): number {
  return tick.toFixed(10).replace(/0+$/, "").split(".")[1]?.length ?? 0;
}

/**
 * Front-month continuous contracts, every one confirmed to resolve through the
 * Yahoo provider. `DX=F` is deliberately absent: Yahoo 404s it, and the dollar
 * index is already on the world indices board as `DX-Y.NYB`.
 */
export const FUTURES_CONTRACTS: FuturesContract[] = [
  { symbol: "ES=F", code: "ES", name: "E-Mini S&P 500", sector: "equity-index", venue: "CME", tick: 0.25 },
  { symbol: "NQ=F", code: "NQ", name: "E-Mini Nasdaq 100", sector: "equity-index", venue: "CME", tick: 0.25 },
  { symbol: "YM=F", code: "YM", name: "E-Mini Dow", sector: "equity-index", venue: "CBT", tick: 1 },
  { symbol: "RTY=F", code: "RTY", name: "E-Mini Russell 2000", sector: "equity-index", venue: "CME", tick: 0.1 },

  { symbol: "ZT=F", code: "ZT", name: "2-Year T-Note", sector: "rates", venue: "CBT" },
  { symbol: "ZF=F", code: "ZF", name: "5-Year T-Note", sector: "rates", venue: "CBT" },
  { symbol: "ZN=F", code: "ZN", name: "10-Year T-Note", sector: "rates", venue: "CBT" },
  { symbol: "ZB=F", code: "ZB", name: "30-Year T-Bond", sector: "rates", venue: "CBT" },
  { symbol: "UB=F", code: "UB", name: "Ultra T-Bond", sector: "rates", venue: "CBT" },

  { symbol: "CL=F", code: "CL", name: "WTI Crude Oil", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.01 },
  { symbol: "BZ=F", code: "BZ", name: "Brent Crude Oil", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.01 },
  { symbol: "NG=F", code: "NG", name: "Natural Gas", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.001 },
  // Quoted in euros per MWh.
  { symbol: "TTF=F", code: "TTF", name: "Dutch TTF Gas", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.001, curve: false },
  { symbol: "RB=F", code: "RB", name: "RBOB Gasoline", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.0001 },
  { symbol: "HO=F", code: "HO", name: "Heating Oil", sector: "energy", venue: "NYM", everyMonth: true, tick: 0.0001 },

  { symbol: "GC=F", code: "GC", name: "Gold", sector: "metals", venue: "CMX", tick: 0.1 },
  { symbol: "SI=F", code: "SI", name: "Silver", sector: "metals", venue: "CMX", tick: 0.005 },
  { symbol: "HG=F", code: "HG", name: "Copper", sector: "metals", venue: "CMX", tick: 0.0005 },
  { symbol: "ALI=F", code: "ALI", name: "Aluminum", sector: "metals", venue: "CMX", tick: 0.25, curve: false },
  { symbol: "PL=F", code: "PL", name: "Platinum", sector: "metals", venue: "NYM", tick: 0.1 },
  { symbol: "PA=F", code: "PA", name: "Palladium", sector: "metals", venue: "NYM", tick: 0.1 },

  // Most grains and softs quote in US cents (cocoa, soybean meal and lumber in
  // dollars); a tick is in the quote's own units.
  { symbol: "ZC=F", code: "ZC", name: "Corn", sector: "agriculture", venue: "CBT", tick: 0.25 },
  { symbol: "ZS=F", code: "ZS", name: "Soybeans", sector: "agriculture", venue: "CBT", tick: 0.25 },
  { symbol: "ZM=F", code: "ZM", name: "Soybean Meal", sector: "agriculture", venue: "CBT", tick: 0.1, curve: false },
  { symbol: "ZL=F", code: "ZL", name: "Soybean Oil", sector: "agriculture", venue: "CBT", tick: 0.01, curve: false },
  { symbol: "ZW=F", code: "ZW", name: "Chicago SRW Wheat", sector: "agriculture", venue: "CBT", tick: 0.25 },
  { symbol: "KE=F", code: "KE", name: "KC HRW Wheat", sector: "agriculture", venue: "CBT", tick: 0.25, curve: false },
  { symbol: "KC=F", code: "KC", name: "Coffee", sector: "agriculture", venue: "NYB", tick: 0.05 },
  { symbol: "SB=F", code: "SB", name: "Sugar #11", sector: "agriculture", venue: "NYB", tick: 0.01 },
  { symbol: "CC=F", code: "CC", name: "Cocoa", sector: "agriculture", venue: "NYB", tick: 1 },
  { symbol: "CT=F", code: "CT", name: "Cotton #2", sector: "agriculture", venue: "NYB", tick: 0.01 },
  { symbol: "OJ=F", code: "OJ", name: "Orange Juice", sector: "agriculture", venue: "NYB", tick: 0.05, curve: false },
  { symbol: "LBR=F", code: "LBR", name: "Lumber", sector: "agriculture", venue: "CME", tick: 0.5, curve: false },

  // Quoted in US cents per pound.
  { symbol: "LE=F", code: "LE", name: "Live Cattle", sector: "livestock", venue: "CME", tick: 0.025, curve: false },
  { symbol: "HE=F", code: "HE", name: "Lean Hogs", sector: "livestock", venue: "CME", tick: 0.025, curve: false },

  { symbol: "6E=F", code: "6E", name: "Euro FX", sector: "currencies", venue: "CME", tick: 0.00005 },
  { symbol: "6J=F", code: "6J", name: "Japanese Yen", sector: "currencies", venue: "CME", tick: 0.0000005 },
  { symbol: "6B=F", code: "6B", name: "British Pound", sector: "currencies", venue: "CME", tick: 0.0001 },
  { symbol: "6A=F", code: "6A", name: "Australian Dollar", sector: "currencies", venue: "CME", tick: 0.00005 },
  { symbol: "6C=F", code: "6C", name: "Canadian Dollar", sector: "currencies", venue: "CME", tick: 0.00005 },
  { symbol: "6S=F", code: "6S", name: "Swiss Franc", sector: "currencies", venue: "CME", tick: 0.00005 },
];

export const FUTURES_SECTOR_LABELS: Record<FuturesSector, string> = {
  "equity-index": "Equity Index",
  rates: "Rates",
  energy: "Energy",
  metals: "Metals",
  agriculture: "Agriculture",
  livestock: "Livestock",
  currencies: "Currencies",
};

export const FUTURES_SECTOR_ORDER: FuturesSector[] = [
  "equity-index",
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
