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

/** A trading halt, an 8-K, or a news story since the prior regular close. */
export type CloudSessionCatalyst = "halt" | "filing" | "news";

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
  floatShares: number | null;
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
  items: CloudSessionMoverItem[];
}

const SESSION_CATEGORIES = new Set<string>(["premarket", "afterhours", "gaps"]);

export function isSessionMoversCategory(category: string): category is CloudSessionMoversCategory {
  return SESSION_CATEGORIES.has(category);
}
