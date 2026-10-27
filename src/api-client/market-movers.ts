/**
 * Pre-market, after-hours and gap lists for MOST, served by the market
 * screener route beside gainers, losers and most active. Methodology:
 * docs/quote-board-data.md.
 */

export type CloudSessionMoversCategory = "premarket" | "afterhours" | "gaps";

/** Up and down moves, or the most shares traded; gaps have no active list. */
export type CloudSessionMoversSide = "up" | "down" | "active";

/** What is trading in New York when the list was built. */
export type CloudSessionPhase = "pre" | "regular" | "post" | "closed";

/** A trading halt, an 8-K, or a news story in the list's own window (see docs/quote-board-data.md). */
type CloudSessionCatalyst = "halt" | "filing" | "news";

export interface CloudSessionMoverItem {
  rank: number;
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  /** Latest price in the list's session. */
  price: number;
  change: number;
  changePercent: number;
  /** What the change is measured from: the prior regular close, or the day's official close after hours. */
  referenceClose: number;
  /** Shares traded in the session: pre-market, after hours, or the day so far for gaps. */
  volume: number;
  /** Volume so far against the average by the same time of day. */
  relativeVolume: number | null;
  /** Open against the prior close; before the open, the last pre-market price. */
  gapPercent: number | null;
  open: number | null;
  /** Regular-session VWAP. */
  vwap: number | null;
  vwapPercent: number | null;
  /** The equity screener's float, null where it serves none. */
  floatShares: number | null;
  /** Set with a float the source states no measurement date for: `partial`. */
  floatSharesState?: "partial";
  /** Why the float is partial, as the server says it. */
  floatSharesReason?: string;
  /** When the statistics the float is read from were retrieved (ISO). */
  floatSharesRetrievedAt?: string;
  catalysts: CloudSessionCatalyst[];
  lastUpdated: number;
}

export interface CloudSessionMoversPayload {
  view: CloudSessionMoversCategory;
  side: CloudSessionMoversSide;
  /** Trading date of the list; before the pre-market opens it is the previous session's. */
  session: string | null;
  phase: CloudSessionPhase;
  asOf: string;
  stale?: boolean;
  /**
   * `delayed` for an account without Pro: the list as it was built at least
   * `delayMinutes` before it was served, as old as that account's quotes,
   * and `asOf` that time. Absent on Pro's live list.
   */
  access?: "delayed";
  delayMinutes?: number;
  items: CloudSessionMoverItem[];
}

const SESSION_CATEGORIES = new Set<string>(["premarket", "afterhours", "gaps"]);

export function isSessionMoversCategory(category: string): category is CloudSessionMoversCategory {
  return SESSION_CATEGORIES.has(category);
}
