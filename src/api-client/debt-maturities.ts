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
  /** SEC's fiscal year for the period, when the server sends it. */
  fy?: number | null;
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
/**
 * What a schedule's amounts are: principal, carrying amounts, or contractual
 * undiscounted cash flows (principal and the interest still to be paid).
 */
export type DebtAmountBasis = "principal" | "carrying" | "contractual_undiscounted";
/** The accounting standard of a schedule read in its filing's own bands. */
export type DebtBandTaxonomy = "ifrs-full" | "cn-cas";
/**
 * One time band exactly as the filing reports it: from and to, in months
 * after the balance-sheet date (to null: open ended), and the rows or members
 * it was read from. Never split into years.
 */
export interface DebtBand {
  label: string;
  fromMonths: number;
  toMonths: number | null;
  value: number;
  members: string[];
}
/** The document a schedule read from the filing itself came from, and what it was checked against. */
export interface DebtLadderSource {
  url: string;
  /** The table, text block or concept the schedule was read from. */
  concept: string;
  /** Units per table unit (1e6 for "in millions"), and whether the table said so. */
  scale: number;
  scaleStated: boolean;
  reconciledTo: { concept: string; value: number; ratio: number } | null;
}
export interface DebtMaturitiesPayload {
  /** 1 from servers before ladders in a filing's own bands; 2 when the server serves them. */
  version: 1 | 2;
  symbol: string;
  cik: string | null;
  entityName: string | null;
  taxonomy: "us-gaap" | DebtBandTaxonomy | null;
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
    /** The document a schedule read from the filing itself came from; null or absent for SEC company facts. */
    source?: DebtLadderSource | null;
    /**
     * Only on a schedule in its filing's own bands (version 2): its standard,
     * what its amounts are, the bands as reported and their sum. `buckets`
     * and the principal figures are then not read.
     */
    taxonomy?: DebtBandTaxonomy;
    amountBasis?: DebtAmountBasis;
    sourceBuckets?: DebtBand[];
    sourceTotal?: number;
    /** The filing counts lease liabilities among these borrowings. */
    includesLeases?: true;
  };
  history: DebtHistoryPoint[];
  /** The latest 10-Q when it is newer than `latest`. Older servers and cached payloads leave it out. */
  latestQuarter?: DebtQuarter | null;
  warnings: string[];
}
