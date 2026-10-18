/** Completed UTC daily closes, oldest first, one slot per calendar day. */
interface CryptoDailyCloses {
  start: string;
  closes: Array<number | null>;
}

export type CryptoAssetKind = "coin" | "stablecoin";

/** What a stablecoin holds to: a currency, or a dollar value that accrues yield. */
export interface CryptoPeg {
  /** The currency it is pegged to: USD, EUR. */
  currency: string;
  /** Yield accrues into the price (USDY): it has no par to be off. */
  accrues: boolean;
  /** The target in dollars: 1 for USD, the EUR/USD rate for EUR; null when it accrues or the rate is unavailable. */
  price: number | null;
  /** When a target that moves (an exchange rate) was quoted; null for USD. */
  asOf: string | null;
}

/** The lowest and highest trade in the 24 hours to `end`, and when each was. */
interface CryptoDayRange {
  low: number;
  lowAt: string;
  high: number;
  highAt: string;
  start: string;
  end: string;
}

export interface CryptoMarketAsset {
  /** The coin's one symbol for quotes, history, streaming and the ticker pane, for example BTC-USD or USDE-USD. */
  symbol: string;
  /** Display code, for example BTC. */
  code: string;
  name: string;
  kind: CryptoAssetKind;
  /** Market-cap rank within its kind. */
  rank: number;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume24h: number | null;
  marketCap: number | null;
  circulatingSupply: number | null;
  maxSupply: number | null;
  high52w: number | null;
  low52w: number | null;
  /** Price one year before the quote, so a live price can restate the 1Y return. */
  yearAgoPrice: number | null;
  quoteTime: string | null;
  history: CryptoDailyCloses | null;
  /** A stablecoin's peg; absent from servers before it was served. */
  peg?: CryptoPeg | null;
  /** A stablecoin's 24-hour low and high; absent from servers before it was served. */
  range24h?: CryptoDayRange | null;
}

export interface CryptoMarketsPayload {
  version: 1;
  generatedAt: string;
  asOf: string | null;
  status: "available" | "partial" | "unavailable";
  source: {
    name: string;
    url: string;
    screenerFetchedAt: string | null;
    historyFetchedAt: string | null;
  };
  assets: CryptoMarketAsset[];
  warnings: string[];
}

/** One stablecoin's supply: units outstanding across chains, valued in USD. */
export interface StablecoinSupplyCoin {
  symbol: string;
  name: string;
  /** The currency the coin is pegged to, as the source names it: peggedUSD, peggedEUR, peggedVAR (a floating target). */
  pegType: string;
  pegMechanism: string | null;
  /** The USD price the supply is valued at; null for a dollar coin the source prices at none (valued at one dollar). */
  price: number | null;
  /** USD. */
  supply: number;
  /** Change in units over 7 and 30 days, valued in USD at today's price, and in percent. */
  change7d: number | null;
  change7dPercent: number | null;
  change30d: number | null;
  change30dPercent: number | null;
  /** Percent of the total stablecoin supply. */
  share: number | null;
}

export interface StablecoinSupplyPayload {
  version: 1;
  generatedAt: string;
  fetchedAt: string | null;
  /** UTC date of the newest daily total. */
  asOf: string | null;
  status: "available" | "stale" | "unavailable";
  source: { name: string; url: string };
  total: {
    supply: number;
    change7d: number | null;
    change7dPercent: number | null;
    change30d: number | null;
    change30dPercent: number | null;
  } | null;
  /** The largest stablecoins by supply, largest first. */
  coins: StablecoinSupplyCoin[];
  /** Daily supply in USD since `start`: the total and the largest coins, on the same days. */
  history: {
    start: string;
    total: Array<number | null>;
    coins: Array<{ symbol: string; name: string; values: Array<number | null> }>;
  } | null;
  warnings: string[];
}

/** One stablecoin's daily supply in USD. */
export interface StablecoinSupplyHistoryPayload {
  version: 1;
  generatedAt: string;
  fetchedAt: string | null;
  asOf: string | null;
  status: "available" | "stale" | "unavailable";
  source: { name: string; url: string };
  symbol: string;
  name: string;
  pegType: string;
  history: { start: string; values: Array<number | null> } | null;
  warnings: string[];
}
