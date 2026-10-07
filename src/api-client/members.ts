interface MemberFund { ticker: string; name: string; aliases: string[]; changes: "sp500" | "announcements" | "none" }
export interface FundMember {
  id: string; symbol: string | null; name: string; sector: string | null;
  weight: number | null; shares: number; holdingPrice: number; marketValue: number;
  price: number | null; priceAsOf: string | null; changePercent: number | null; dailyAsOf: string | null;
  return1WPercent: number | null; return1MPercent: number | null; returnYtdPercent: number | null;
  contribution: number | null; stale: boolean;
}
export interface FundMembersPayload {
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
