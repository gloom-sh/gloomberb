interface MemberFund { ticker: string; name: string; aliases: string[]; changes: "sp500" | "announcements" | "none" }
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
export interface MemberFundsPayload { funds: (MemberFund & { asOf: string | null })[] }

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
