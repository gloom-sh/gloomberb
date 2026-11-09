interface MemberFund {
  ticker: string; name: string; aliases: string[]; changes: "sp500" | "announcements" | "none";
  /**
   * Where the fund's holdings come from: its issuer's daily file, or its latest SEC N-PORT report (quarterly,
   * filed up to 60 days after the date it is as of). An older server leaves it out (daily).
   */
  basis?: "daily" | "nport";
  /** An N-PORT fund's own name: its `name` ends in "(N-PORT)" for apps that know nothing of `basis`. */
  plainName?: string;
}
export interface FundMember {
  id: string; symbol: string | null; name: string; sector: string | null;
  weight: number | null; shares: number; holdingPrice: number | null; marketValue: number | null;
  price: number | null; priceAsOf: string | null; changePercent: number | null; dailyAsOf: string | null;
  return1WPercent: number | null; return1MPercent: number | null; returnYtdPercent: number | null;
  contribution: number | null; stale: boolean;
}
export interface FundMembersPayload {
  /**
   * Whose prices the members carry: `realtime` for a Pro account, priced from
   * a live read the server renews every 15 seconds; `delayed`, fifteen
   * minutes behind, otherwise. An older server leaves it out (delayed).
   */
  access?: "realtime" | "delayed";
  fund: MemberFund; asOf: string; fetchedAt: string; excludedDerivatives: number; stale: boolean;
  /** As the fund's `basis`; with an N-PORT report, the day it was filed and the report itself. */
  basis?: "daily" | "nport"; filedOn?: string | null; sourceUrl?: string;
  /** An N-PORT report's short positions and negative weights, left out apart from its derivatives. */
  excludedShorts?: number;
  quotesUnavailable: boolean; snapshotAsOf: string | null; fundDailyAsOf: string | null; quoteCap: number;
  members: FundMember[];
  aggregate: { sum: number | null; fundReturn: number | null; residual: number | null; tolerancePp: number;
    withinTolerance: boolean | null; covered: number; total: number; coveredWeight: number; holdingsWeight: number; fresh1D: number };
}
export interface FundChange {
  id: string; fund: string; effectiveDate: string | null; announcedAt: string | null;
  added: string | null; removed: string | null; reason: string; headline: string | null; url: string;
  kind: "history" | "announcement"; daysToGo: number | null;
  estimates: { symbol: string; usd: number; advUsd: number; days: number; asOf: string; advAsOf: string | null }[];
}
export interface FundChangesPayload {
  fund: MemberFund; changes: FundChange[]; asOf: string | null; stale: boolean; available: boolean;
  estimateLabel: string; attribution: { text: string; url: string } | null;
}
export interface MemberFundsPayload { funds: (MemberFund & { asOf: string | null; filedOn?: string | null })[] }
/**
 * An ETF holding a stock: its weight in the fund's latest holdings, and what those holdings are as of. A covered
 * fund's `name` is the one MEMB lists it under; any other fund's is its N-PORT report's.
 */
export interface StockFund {
  ticker: string; name: string; basis: "daily" | "nport"; weight: number | null; shares: number; marketValue: number | null;
  /** The stock as the fund's holdings name it. */
  holdingName: string;
  asOf: string; filedOn: string | null; sourceUrl?: string;
}
/**
 * The ETFs holding a stock: the covered funds on daily files first, then every other US ETF whose latest N-PORT
 * report holds it, each by weight. `coverage` counts the funds looked through of each kind.
 */
export interface StockFundsPayload { symbol: string; funds: StockFund[]; coverage: { daily: number; nport: number } }

interface BreadthCount { above: number; eligible: number; percent: number | null }
export interface BreadthDay {
  date: string; asOf: string; membershipAsOf: string; memberCount: number; observed: number;
  advances: number; declines: number; unchanged: number; advanceDeclineEligible: number;
  ma20: BreadthCount; ma50: BreadthCount; ma200: BreadthCount;
  newHighs: number; newLows: number; highLowEligible: number; adLine: number | null;
}
export interface FundBreadthPayload {
  fund: MemberFund; basis: "daily-close" | "intraday"; access?: "realtime" | "delayed"; membershipBasis: "current-members";
  latest: BreadthDay | null; history: BreadthDay[]; stale: boolean;
}
