export type RevenueBreakdownView = "product" | "segment" | "region";

interface QuarterlyRevenueBreakdownPeriod {
  /** Period end, rounded to the month end as the SEC data sets do. */
  end: string;
  fiscalYear: number;
  fiscalQuarter: number;
}

export interface ReportedRevenueBreakdownPeriod {
  end: string;
  kind: "annual" | "interim" | "quarter";
  label: string;
  revenueLabel: string;
  singleSegment?: true;
  filing: { filed: string; url: string; page: number | null };
}

export type RevenueBreakdownPeriod = QuarterlyRevenueBreakdownPeriod | ReportedRevenueBreakdownPeriod;

export interface RevenueBreakdownRow {
  key: string;
  label: string;
  /** Oldest to newest, aligned with `periods`. */
  values: (number | null)[];
  ttm: number | null;
  /** Fraction, e.g. 0.217 for +21.7%. */
  yoy: number | null;
  /** Fraction of the latest quarter's total revenue. */
  share: number | null;
}

export interface RevenueBreakdownPayload {
  symbol: string;
  cik?: string;
  currency: string;
  view: RevenueBreakdownView;
  views: RevenueBreakdownView[];
  periods: RevenueBreakdownPeriod[];
  total: (number | null)[];
  rows: RevenueBreakdownRow[];
  /** Date of the latest filing read for the company. */
  filed: string | null;
  access: "full" | "preview";
  /** Rows withheld from a preview. */
  lockedRows: number;
}

/** Venues where company filings can supply reported revenue periods. */
export const reportedRevenueVenue = (exchange: string | undefined) =>
  exchange === "HKEX" || exchange === "SSE" || exchange === "SZSE" || exchange === "KRX" || exchange === "KOSDAQ";
