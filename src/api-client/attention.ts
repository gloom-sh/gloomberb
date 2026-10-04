export type AttentionWindow = "now" | "today" | "week";
export interface AttentionPoint {
  bucketStart: string; researchUnits: number; publishedAt?: string; minimumContributors?: number;
  rounding?: number; lagHours?: number; methodologyVersion?: number;
}
export interface AttentionRow {
  symbol: string; ticker: string; exchange: string; name: string | null; country: string | null; sector: string | null;
  rank: number; researchUnits: number; sharePct: number; zScore: number | null; baselinePeriods: number;
  priceChangePct: number | null; relativeVolume: number | null; marketAsOf: string | null; relativeVolumeAsOf?: string | null;
  news: Array<{ title: string; url: string; publishedAt: string }>;
  history: AttentionPoint[];
  evidence: { source: string; asOf: string; periodStart: string; periodEnd: string; unit: string; confidence: string; methodologyVersion: number };
}
export interface AttentionGroup { name: string; researchUnits: number; sharePct: number; tickers: number }
export interface AttentionPayload {
  generatedAt: string; asOf: string | null; window: AttentionWindow; periodStart: string; periodEnd: string;
  status: "disabled" | "collecting" | "ready"; stale: boolean;
  rows: AttentionRow[]; sectors: AttentionGroup[]; countries: AttentionGroup[];
  privacy: { minimumContributors: number; rounding: number; lagHours: number; methodologyVersion: number };
  coverage: { publishedHours: number; publishedTickers: number; baselineDays: number };
  history?: AttentionPoint[];
  selectedListing?: Pick<AttentionRow, "symbol" | "ticker" | "exchange" | "name" | "country" | "sector"> | null;
  historyEvidence?: AttentionRow["evidence"] | null;
  methodologyUrl: string; entitlement: "pro" | "preview"; truncated: boolean;
  counts: { rows: number; sectors: number; countries: number };
}
