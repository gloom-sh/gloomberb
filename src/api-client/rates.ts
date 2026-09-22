/** Gloom Cloud rate-path contract. Rates are percentage points; probabilities are fractions. */
export interface RateMetric {
  value: number | null;
  asOf: string | null;
  percentile: number | null;
  samples: number;
  source: "fred" | "nyfed" | null;
  stale?: boolean;
}

export interface RateContract {
  symbol: string;
  month: string;
  price: number | null;
  impliedRate: number | null;
  asOf: string | null;
  percentile: number | null;
  samples: number;
  status: "available" | "unavailable";
  stale: boolean;
}

export interface RateMeeting {
  date: string;
  impliedRate: number | null;
  targetMidpoint: number | null;
  changeBps: number | null;
  percentile: number | null;
  samples: number;
  asOf: string | null;
  probabilities: Array<{ targetMidpoint: number; probability: number }>;
  method: "following-month" | "monthly-weighted" | null;
  reason: string | null;
}

export interface RatePathPayload {
  asOf: string | null;
  fetchedAt: string;
  stale: boolean;
  status: "available" | "partial" | "unavailable";
  current: { effr: RateMetric; targetLower: RateMetric; targetUpper: RateMetric };
  meetings: RateMeeting[];
  fedFunds: RateContract[];
  sofr: RateContract[];
  ghosts: Array<{
    label: "1W" | "1M" | "1Y";
    requestedDate: string;
    asOf: string | null;
    points: Array<{ date: string; impliedRate: number | null }>;
  }>;
  dotPlot: { asOf: string; sourceUrl: string; points: Array<{ year: number | "longer-run"; rate: number }> };
  schedule: { sourceUrl: string; verifiedAt: string; through: string };
  probabilityAssumption: string;
  slope: { valueBps: number | null; percentile: number | null; samples: number; asOf: string | null };
  gaps: string[];
}
