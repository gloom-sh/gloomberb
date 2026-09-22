export interface CryptoPercentile {
  value: number | null;
  rank: number | null;
  sampleCount: number;
  windowStart: string;
  windowEnd: string;
  historyStart: string | null;
  historyEnd: string | null;
  completeWindow: boolean;
  min: number | null;
  max: number | null;
  mean: number | null;
}
export interface CryptoBoardRow {
  symbol: string;
  providerSymbol: string;
  name: string;
  baseCurrency: string;
  quoteCurrency: "USD";
  status: "available" | "partial" | "unavailable";
  asOf: string | null;
  price: {
    value: number | null;
    asOf: string | null;
    freshness: "current" | "stale" | "unavailable";
    basis: "latest-trade";
    percentile: CryptoPercentile & { referenceBasis: "completed-utc-bars-with-quote-midpoints" };
  };
  dailyChange: {
    valuePercent: number | null;
    asOf: string | null;
    referenceDate: string | null;
    referenceClose: number | null;
    basis: "since-prior-utc-close";
    percentile: CryptoPercentile;
  };
  return7d: {
    valuePercent: number | null;
    asOf: string | null;
    startDate: string;
    endDate: string;
    basis: "completed-utc-closes";
    percentile: CryptoPercentile;
  };
  volume: {
    value: number | null;
    unit: string;
    asOf: string | null;
    periodStart: string;
    periodEnd: string;
    basis: "completed-utc-day";
    percentile: CryptoPercentile;
  };
  history: Array<{
    date: string;
    close: number | null;
    volume: number | null;
    tradeCount: number | null;
    status: "observed" | "quote-only" | "missing";
  }>;
  coverage: {
    windowStart: string;
    windowEnd: string;
    expectedDays: number;
    observedDays: number;
    missingDays: number;
    quoteOnlyDays: number;
    completeWindow: boolean;
  };
  warnings: string[];
}
export interface CryptoBoardPayload {
  version: 1;
  generatedAt: string;
  asOf: string | null;
  freshness: { currentPrices: number; stalePrices: number; unavailablePrices: number };
  status: "available" | "partial" | "unavailable";
  source: {
    name: string;
    venue: "us";
    url: string;
    methodologyUrl: string;
    priceBasis: string;
    volumeBasis: string;
    snapshotsFetchedAt: string | null;
    historyFetchedAt: string | null;
  };
  rows: CryptoBoardRow[];
  warnings: string[];
}
