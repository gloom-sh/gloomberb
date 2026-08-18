export type FuturesSector =
  | "equity-index"
  | "rates"
  | "energy"
  | "metals"
  | "agriculture"
  | "currencies";

export interface FuturesContract {
  /** Yahoo continuous front-month symbol. */
  symbol: string;
  /** Exchange code traders quote, e.g. ES. */
  code: string;
  name: string;
  sector: FuturesSector;
}

/**
 * Front-month continuous contracts, every one confirmed to resolve through the
 * Yahoo provider. `DX=F` is deliberately absent: Yahoo 404s it, and the dollar
 * index is already on the world indices board as `DX-Y.NYB`.
 */
export const FUTURES_CONTRACTS: FuturesContract[] = [
  { symbol: "ES=F", code: "ES", name: "E-Mini S&P 500", sector: "equity-index" },
  { symbol: "NQ=F", code: "NQ", name: "E-Mini Nasdaq 100", sector: "equity-index" },
  { symbol: "YM=F", code: "YM", name: "E-Mini Dow", sector: "equity-index" },
  { symbol: "RTY=F", code: "RTY", name: "E-Mini Russell 2000", sector: "equity-index" },

  { symbol: "ZT=F", code: "ZT", name: "2-Year T-Note", sector: "rates" },
  { symbol: "ZF=F", code: "ZF", name: "5-Year T-Note", sector: "rates" },
  { symbol: "ZN=F", code: "ZN", name: "10-Year T-Note", sector: "rates" },
  { symbol: "ZB=F", code: "ZB", name: "30-Year T-Bond", sector: "rates" },
  { symbol: "UB=F", code: "UB", name: "Ultra T-Bond", sector: "rates" },

  { symbol: "CL=F", code: "CL", name: "WTI Crude Oil", sector: "energy" },
  { symbol: "BZ=F", code: "BZ", name: "Brent Crude Oil", sector: "energy" },
  { symbol: "NG=F", code: "NG", name: "Natural Gas", sector: "energy" },
  { symbol: "RB=F", code: "RB", name: "RBOB Gasoline", sector: "energy" },
  { symbol: "HO=F", code: "HO", name: "Heating Oil", sector: "energy" },

  { symbol: "GC=F", code: "GC", name: "Gold", sector: "metals" },
  { symbol: "SI=F", code: "SI", name: "Silver", sector: "metals" },
  { symbol: "HG=F", code: "HG", name: "Copper", sector: "metals" },
  { symbol: "PL=F", code: "PL", name: "Platinum", sector: "metals" },
  { symbol: "PA=F", code: "PA", name: "Palladium", sector: "metals" },

  { symbol: "ZC=F", code: "ZC", name: "Corn", sector: "agriculture" },
  { symbol: "ZS=F", code: "ZS", name: "Soybeans", sector: "agriculture" },
  { symbol: "ZW=F", code: "ZW", name: "Chicago SRW Wheat", sector: "agriculture" },
  { symbol: "KC=F", code: "KC", name: "Coffee", sector: "agriculture" },
  { symbol: "SB=F", code: "SB", name: "Sugar #11", sector: "agriculture" },
  { symbol: "CC=F", code: "CC", name: "Cocoa", sector: "agriculture" },
  { symbol: "CT=F", code: "CT", name: "Cotton #2", sector: "agriculture" },

  { symbol: "6E=F", code: "6E", name: "Euro FX", sector: "currencies" },
  { symbol: "6J=F", code: "6J", name: "Japanese Yen", sector: "currencies" },
  { symbol: "6B=F", code: "6B", name: "British Pound", sector: "currencies" },
  { symbol: "6A=F", code: "6A", name: "Australian Dollar", sector: "currencies" },
  { symbol: "6C=F", code: "6C", name: "Canadian Dollar", sector: "currencies" },
  { symbol: "6S=F", code: "6S", name: "Swiss Franc", sector: "currencies" },
];

export const FUTURES_SECTOR_LABELS: Record<FuturesSector, string> = {
  "equity-index": "Equity Index",
  rates: "Rates",
  energy: "Energy",
  metals: "Metals",
  agriculture: "Agriculture",
  currencies: "Currencies",
};

export const FUTURES_SECTOR_ORDER: FuturesSector[] = [
  "equity-index",
  "rates",
  "energy",
  "metals",
  "agriculture",
  "currencies",
];

export function getContractsBySector(): Map<FuturesSector, FuturesContract[]> {
  const map = new Map<FuturesSector, FuturesContract[]>();
  for (const sector of FUTURES_SECTOR_ORDER) {
    map.set(sector, FUTURES_CONTRACTS.filter((contract) => contract.sector === sector));
  }
  return map;
}
