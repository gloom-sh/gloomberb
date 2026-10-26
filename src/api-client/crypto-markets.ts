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
  /**
   * The day's move as `quote` gives the coin: from the previous UTC day's
   * close, the price at 00:00 UTC. A coin whose close Gloom Cloud cannot date
   * to the last two days moves over 24 hours (`changeBasis` "24h") or not at
   * all ("none"), its previousClose null.
   */
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  changeBasis?: "24h" | "none";
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
  /** Each asset's change is since 00:00 UTC; a server before it sent the screener's 24-hour move. */
  dayChangeBasis?: "utc-day";
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

/** One stablecoin's supply across chains in USD, on the board's as-of day. */
export interface StablecoinSupplyCoin {
  symbol: string;
  name: string;
  /** The currency the coin is pegged to, as the source names it: peggedUSD, peggedEUR, peggedVAR (a floating target). */
  pegType: string;
  pegMechanism: string | null;
  /** USD per unit the day's supply is valued at; null when the source states no units that day. */
  price: number | null;
  /** USD on the as-of day: the same figure the coin's daily supply ends on. */
  supply: number;
  /** Change in USD over 7 and 30 days on the coin's daily supply, and in percent of the value then. */
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

/** DeFi TVL's total, in USD, on the board's as-of day, with its 7D and 30D change. */
interface DefiTvlTotal {
  tvl: number;
  change7d: number | null;
  change7dPercent: number | null;
  change30d: number | null;
  change30dPercent: number | null;
}

/** A protocol, its versions counted together as the source ranks them (Aave: V3, V2, V4...). */
export interface DefiTvlProtocol {
  name: string;
  /** The category of its largest version: Lending, Liquid Staking, Dexs. */
  category: string | null;
  /** How many chains it is deployed on. */
  chains: number;
  /** USD, read at the payload's `protocolsAsOf`. */
  tvl: number;
  change1dPercent: number | null;
  change7d: number | null;
  change7dPercent: number | null;
  change30d: number | null;
  change30dPercent: number | null;
}

export interface DefiTvlChain {
  name: string;
  tokenSymbol: string | null;
  /** USD on the as-of day, from the chain's daily chart. */
  tvl: number;
  change7d: number | null;
  change7dPercent: number | null;
  change30d: number | null;
  change30dPercent: number | null;
  /** Percent of the total DeFi TVL the same day. */
  share: number | null;
}

export interface DefiTvlPayload {
  version: 1;
  generatedAt: string;
  /** When the source was last read. */
  fetchedAt: string | null;
  /** UTC date of the newest daily total. */
  asOf: string | null;
  status: "available" | "stale" | "unavailable";
  /** Who measures the TVL: its definition of locked value is theirs. */
  source: { name: string; url: string };
  total: DefiTvlTotal | null;
  /** The largest protocols by TVL, largest first. */
  protocols: DefiTvlProtocol[];
  /** When the protocols' figures were read: the source's latest, not a daily close. */
  protocolsAsOf: string | null;
  /** The largest chains by TVL, largest first. */
  chains: DefiTvlChain[];
  /** Total DeFi TVL in USD per UTC day since `start`, its first day with value locked. */
  history: { start: string; total: Array<number | null> } | null;
  warnings: string[];
}
