import type { Quote } from "../../types/financials";

export type CloudMarketScreenerCategory = "gainers" | "losers" | "most-active";

/**
 * What Gloom Cloud selects and ranks Gainers and Losers by: `regular` the last
 * completed regular session's move, the Chg% a row shows; `extended` the
 * latest print, after-hours or pre-market included. While the regular session
 * trades the two are one list. A server that predates the choice ignores it
 * and ranks by the latest print.
 */
export type CloudMoverSession = "regular" | "extended";

/**
 * A movers row's quote sessions, under the quote's field names and meaning:
 * the session it was read in, the day its change is dated to, the last
 * completed regular session's close and move, and an open pre-market or
 * after-hours print with its move from that close. Older servers send none.
 */
export type CloudMoverSessionFields = Partial<Pick<Quote,
  | "marketState" | "changeSessionDate"
  | "regularClose" | "regularCloseSessionDate" | "regularChange" | "regularChangePercent"
  | "preMarketPrice" | "preMarketChange" | "preMarketChangePercent"
  | "postMarketPrice" | "postMarketChange" | "postMarketChangePercent">>;

/** price, change and changePercent are the live print the server ranks the list by; the session fields say how it reads. */
export interface CloudMarketScreenerItem extends CloudMoverSessionFields {
  rank: number;
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose?: number;
  volume: number;
  /** Available average volume for this listing, independent of public ranking membership. */
  avgVolume?: number;
  /** Observation time of the optional retained metadata. */
  metadataAsOf?: string;
  /** The listing's market cap from the same retained metadata, where it has one. */
  marketCap?: number;
  tradeCount?: number;
  currency: string;
  high52w?: number;
  low52w?: number;
  dayHigh?: number;
  dayLow?: number;
  exchange: string;
  lastUpdated: number;
  dataSource: "live";
  /** The listing's float as the equity screener serves it; absent where it serves none. */
  floatShares?: number;
  /** Set with a float the source states no measurement date for: `partial`. */
  floatSharesState?: "partial";
  /** Why the float is partial, as the server says it. */
  floatSharesReason?: string;
  /** When the statistics the float is read from were retrieved (ISO). */
  floatSharesRetrievedAt?: string;
}

export interface CloudMarketScreenerPayload {
  providerId: "gloomberb-cloud";
  category: CloudMarketScreenerCategory;
  asOf: string;
  stale?: boolean;
  items: CloudMarketScreenerItem[];
}
