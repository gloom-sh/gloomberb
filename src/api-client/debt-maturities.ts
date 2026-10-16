export interface DebtFact {
  value: number;
  tag: string;
  unit: string;
  start: string | null;
  end: string;
  accession: string;
  filed: string;
  form: string;
}
interface DebtBorrowingCost {
  value: number;
  interest: DebtFact;
  opening: DebtFact[];
  closing: DebtFact[];
  periodStart: string;
  periodEnd: string;
}
interface DebtPercentile {
  value: number | null;
  rank: number | null;
  sampleCount: number;
  minimumSamples: number;
  windowStart: string;
  windowEnd: string;
  historyStart: string | null;
  historyEnd: string | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}
export interface DebtMetric {
  value: number | null;
  unit: string;
  asOf: string;
  filed: string;
  percentile: DebtPercentile;
}
export interface DebtHistoryPoint {
  asOf: string;
  filed: string;
  accession: string;
  currency: string;
  complete: boolean;
  totalPrincipal: number | null;
  next12Months: number | null;
  next12MonthsShare: number | null;
  next3Years: number | null;
  next3YearsShare: number | null;
  interestExpense: number | null;
  borrowingCostPercent: number | null;
  interestExpenseTag: string | null;
  borrowingCostDebtTags: string | null;
}
/**
 * The debt a 10-Q filed after the annual schedule reports on its balance
 * sheet date: what is due within a year and what is due later.
 */
export interface DebtQuarter {
  asOf: string;
  filed: string;
  accession: string;
  form: string;
  currency: string;
  filingUrl: string;
  current: DebtFact | null;
  noncurrent: DebtFact | null;
}
export interface DebtMaturitiesPayload {
  version: 1;
  symbol: string;
  cik: string | null;
  entityName: string | null;
  taxonomy: "us-gaap" | null;
  status: "available" | "partial" | "unavailable";
  fetchedAt: string;
  asOf: string | null;
  source: { name: string; url: string; cadence: string };
  latest: null | {
    asOf: string;
    filed: string;
    accession: string;
    form: string;
    currency: string;
    filingUrl: string;
    complete: boolean;
    buckets: Array<{
      id: string;
      label: string;
      year: number | null;
      value: number | null;
      fact: DebtFact | null;
    }>;
    totalPrincipal: DebtMetric;
    next12Months: DebtMetric;
    next12MonthsShare: DebtMetric;
    next3Years: DebtMetric;
    next3YearsShare: DebtMetric;
    interestExpense: DebtMetric;
    borrowingCostPercent: DebtMetric;
    interestExpenseFact: DebtFact | null;
    borrowingCostEvidence: DebtBorrowingCost | null;
  };
  history: DebtHistoryPoint[];
  /** The latest 10-Q when it is newer than `latest`. Older servers and cached payloads leave it out. */
  latestQuarter?: DebtQuarter | null;
  warnings: string[];
}
