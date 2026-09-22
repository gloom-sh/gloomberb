export interface PercentileStatistics {
  percentile: number | null;
  rank: number | null;
  samples: number;
  min: number | null;
  max: number | null;
  mean: number | null;
}
export type EstimateStatus = "available" | "partial" | "unavailable";
export interface EstimateSourceState {
  status: EstimateStatus;
  fetchedAt: string | null;
  stale: boolean;
  reason: string | null;
}
export interface EstimateObservation {
  date: string;
  recordedAt: string | null;
  average: number | null;
  low: number | null;
  high: number | null;
  analysts: number | null;
  range: number | null;
  relativeRange: number | null;
  source: "yahoo" | "yahoo-eps-trend";
}
export interface RevisionBreadth {
  days: 7 | 30;
  up: number | null;
  down: number | null;
  net: number | null;
  ratio: number | null;
  asOf: string | null;
  percentile: null;
}
export interface EstimatePeriod {
  id: string;
  frequency: "quarterly" | "annual";
  periodEnd: string;
  currency: string | null;
  label: string;
  current: (EstimateObservation & { growth: number | null }) | null;
  revenue: {
    average: number | null;
    low: number | null;
    high: number | null;
    currency: string | null;
    analysts: number | null;
    asOf: string | null;
  } | null;
  recorded: EstimateObservation[];
  lookbacks: EstimateObservation[];
  percentile: PercentileStatistics & {
    window: "1Y";
    firstDate: string | null;
    lastDate: string | null;
  };
  dispersionPercentile: PercentileStatistics;
  change: {
    value: number | null;
    percent: number | null;
    fromDate: string | null;
    toDate: string | null;
  };
  breadth: RevisionBreadth[];
}
export interface EstimateSurprise {
  date: string;
  dateType: "announcement" | "fiscal-period-end" | "unspecified";
  currency: string | null;
  estimate: number | null;
  actual: number | null;
  difference: number | null;
  percent: number | null;
  percentile: number | null;
  samples: number;
  source: string;
}
export interface EstimateGuidance {
  callDate: string | null;
  fiscalYear: number;
  fiscalQuarter: number;
  publishedAt: string;
  text: string;
  transcriptURL: string;
  webcastURL: string | null;
  source: "public-transcript-summary";
  numericComparison: null;
}
export interface EstimateRevisionsPayload {
  symbol: string;
  exchange: string;
  generatedAt: string;
  status: EstimateStatus;
  sources: {
    consensus: EstimateSourceState;
    history: EstimateSourceState;
    reported: EstimateSourceState;
    guidance: EstimateSourceState;
  };
  periods: EstimatePeriod[];
  surprises: EstimateSurprise[];
  guidance: EstimateGuidance | null;
  historyCoverage: {
    since: string;
    until: string;
    truncated: boolean;
    excludedRows: number;
    recordedDays: number;
    lookbackRows: number;
  };
  gaps: string[];
}
