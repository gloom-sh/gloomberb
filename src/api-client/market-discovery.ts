import type { CloudCorporateActionsPayload, CloudMoverSessionFields, CloudQuotePayload } from "./types";

export interface ScreenerQuote {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  avgVolume: number | null;
  volumeRatio: number | null; // volume / avgVolume
  marketCap: number | undefined;
  currency: string;
  fiftyTwoWeekHigh: number | undefined;
  fiftyTwoWeekLow: number | undefined;
  dayHigh: number | undefined;
  dayLow: number | undefined;
  exchange: string;
  lastUpdated?: number;
  /** Session-fixed, so the price column reads its decimals from it rather than from each tick. */
  previousClose?: number;
  /** The quote's sessions beside the live print the server ranked the row by, when the server sends them. */
  sessions?: CloudMoverSessionFields;
}


export type MarketHeatmapUniverseId = "us-equity" | "us-etf";
type MarketHeatmapSource = "gloom";
type MarketHeatmapSizeKind = "market-cap" | "net-assets";
export interface MarketHeatmapAsset {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  /**
   * Whether the source actually carried a session change. `changePercent` keeps
   * a numeric 0 for the shared screener row shape, so tiles must read this
   * before showing a flat session that was really missing data.
   */
  hasChange: boolean;
  size: number | null;
  sizeKind: MarketHeatmapSizeKind;
  volume: number | null;
  currency: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
  marketState: string | null;
  source: MarketHeatmapSource;
  /**
   * The move of the last completed regular session, which `price`, `change`
   * and `changePercent` then are. Null while the regular session trades, and
   * for a name without that session's close.
   */
  regularChangePercent?: number | null;
}

export interface MarketHeatmapResult {
  stale?: boolean;
  universe: MarketHeatmapUniverseId;
  source: MarketHeatmapSource;
  /**
   * Whose prices the board carries: `realtime` for a Pro account, priced
   * from a live read the server takes every 15 seconds; `delayed`, fifteen
   * minutes behind, otherwise. An older server leaves it out (delayed).
   */
  access?: "realtime" | "delayed";
  fetchedAt: number;
  /** The US market session the snapshot describes; null when the server cannot tell. */
  session?: "REGULAR" | "PRE" | "POST" | "CLOSED" | null;
  /** The completed regular session every stored tile describes outside the regular session, as a New York date; null while it trades. */
  regularSessionDate?: string | null;
  /**
   * When that session closed, in epoch milliseconds: its real close from the
   * exchange calendar, so an early close reads 13:00 New York. Null while a
   * session trades and when the snapshot names no session; an older server
   * leaves it out.
   */
  regularSessionClosedAt?: number | null;
  /**
   * When the prices the board's moves are read at were printed, in epoch
   * milliseconds, never later than any of them: the oldest delayed print
   * while the session trades, that session's close outside it. `fetchedAt`
   * is when the server put the snapshot together, at least fifteen minutes
   * later. Null when a print is unknown; an older server leaves it out.
   */
  pricesAsOf?: number | null;
  assets: MarketHeatmapAsset[];
}


export interface MarketMoversPayload {
  quotes: ScreenerQuote[];
  source: "gloom";
  stale: boolean;
  asOf: string;
}

export interface DividendSummary {
  trailingAnnualDividendRate: number | null;
  trailingAnnualDividendYield: number | null;
  /** The indicated annual rate fundamentals serve: the latest regular distribution annualized. */
  forwardAnnualDividendRate: number | null;
  /** The ex-date of the distribution that rate annualizes, YYYY-MM-DD. */
  forwardRateAsOf?: string | null;
  payoutRatio: number | null;
  exDividendDate: number | null;
  dividendDate: number | null;
  currency: string | null;
}

export interface MarketDividendsPayload {
  stale?: boolean;
  actions: CloudCorporateActionsPayload | null;
  quote: CloudQuotePayload | null;
  summary: DividendSummary | null;
  historyError?: string;
  summaryError?: string;
}
