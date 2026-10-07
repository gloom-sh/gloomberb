/** Before the open, during the session, after the close. */
export type EarningsTiming = "bmo" | "dmh" | "amc";

interface EarningsImpliedMove {
  /** Straddle over spot, the move priced in either direction. */
  move: number;
  straddle: number;
  spot: number;
  strike: number;
  expiry: string;
  /** The session whose prices it comes from. */
  session: string;
  method: "quote-mid" | "trade-close";
  /** Priced in the last session before the report; earlier captures move until then. */
  final: boolean;
  at: string;
}

interface EarningsRealizedMove {
  /** Signed: the close after the report over the close before it, minus one. */
  move: number;
  baseSession: string;
  baseClose: number;
  afterSession: string;
  afterClose: number;
}

export interface EarningsReport {
  symbol: string;
  name: string | null;
  /** Report date, New York. */
  date: string;
  timing: EarningsTiming | null;
  /** `history` means inferred from the company's last reports, not announced. */
  timingSource: "filing" | "calendar" | "history" | null;
  reportedAt: string | null;
  /** Fiscal quarter end month, YYYY-MM. */
  fiscalPeriod: string | null;
  marketCap: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  epsAnalysts: number | null;
  revenueEstimate: number | null;
  revenueAnalysts: number | null;
  implied: EarningsImpliedMove | null;
  realized: EarningsRealizedMove | null;
}

export interface EarningsCalendarReport extends EarningsReport {
  /** Mean absolute move over the company's last eight reports before this range. */
  averageMove: number | null;
  averageReports: number;
}

export interface EarningsCalendarPayload {
  asOf: string;
  from: string;
  to: string;
  reports: EarningsCalendarReport[];
}

interface EarningsHistoryReport extends EarningsReport {
  revenueActual: number | null;
}

export interface EarningsHistoryPayload {
  asOf: string;
  symbol: string;
  name: string | null;
  /** Newest first; an upcoming report leads. */
  reports: EarningsHistoryReport[];
}

export interface EarningsCalendarQuery {
  from: string;
  to: string;
  /** Largest companies kept per day; the listed symbols are always kept. */
  perDay?: number;
  symbols?: readonly string[];
}
