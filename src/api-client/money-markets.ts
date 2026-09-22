/** Money-market observations from Cloud. Rates use percent; liquidity uses USD billions. */
export interface MoneyMarketObservation {
  date: string;
  value: number | null;
}

export interface MoneyMarketPercentile {
  value: number | null;
  rank: number | null;
  sampleCount: number;
  windowStart: string | null;
  windowEnd: string | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

export interface MoneyMarketRow {
  id: string;
  label: string;
  seriesId: string | null;
  sourceSeriesIds: string[];
  sourceUrl: string | null;
  group: "rates" | "bills" | "liquidity";
  unit: "percent" | "usd-billions";
  frequency: "daily" | "weekly";
  value: number | null;
  asOf: string | null;
  previousValue: number | null;
  previousAsOf: string | null;
  change: number | null;
  changeUnit: "basis-points" | "usd-billions";
  percentile: MoneyMarketPercentile;
  history: MoneyMarketObservation[];
  status: "available" | "stale" | "unavailable";
  fetchedAt: string | null;
  unavailableReason: "source-unavailable" | "metadata-unavailable" | "metadata-mismatch" | "no-observations" | "components-unavailable" | null;
  notes: string[];
}

interface BillSnapshot {
  asOf: string | null;
  points: Array<{ tenor: string; maturityYears: number; seriesId: string; value: number }>;
}

export interface MoneyMarketsPayload {
  generatedAt: string;
  status: "available" | "partial" | "unavailable";
  rows: MoneyMarketRow[];
  billsCurve: BillSnapshot & {
    status: MoneyMarketRow["status"];
    basis: "discount";
    comparisons: Array<BillSnapshot & { period: "1W" | "1M" | "1Y"; targetDate: string | null }>;
    slope: { valueBps: number | null; asOf: string | null; percentile: MoneyMarketPercentile; history: MoneyMarketObservation[] };
  };
  netLiquidity: MoneyMarketRow;
}
