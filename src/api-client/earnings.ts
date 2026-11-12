import type { EarningsDateStatus, EarningsEpsBasis } from "../types/financials";

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

/** `filing` is a listing abroad's own results announcement. */
type EarningsActualSource = "calendar" | "press-release" | "filing";

/** What a report's figures cover; a US report is always a quarter. */
export type EarningsPeriodKind = "quarter" | "half" | "ytd" | "year";

export interface EarningsReport {
  symbol: string;
  name: string | null;
  /** Report date, New York. */
  date: string;
  timing: EarningsTiming | null;
  /** `history` means inferred from the company's last reports, not announced; `company` that the company announced the date itself. */
  timingSource: "filing" | "calendar" | "history" | "company" | null;
  /** When the results come out, as the company announced it, for `company` dates with a time. Absent from older servers. */
  announcedAt?: string | null;
  reportedAt: string | null;
  /** Fiscal quarter end month, YYYY-MM. */
  fiscalPeriod: string | null;
  /** The company's cap as RV reads it: its latest snapshot at the regular session's price. */
  marketCap: number | null;
  /** For an upcoming report, the consensus every earnings view shows, with `epsAnalysts` behind it. */
  epsEstimate: number | null;
  epsActual: number | null;
  /**
   * Where `epsActual` comes from: `press-release` is the company's own
   * release, read the day it reports and provisional until the calendar's
   * figure replaces it. Absent from older servers.
   */
  epsActualSource?: EarningsActualSource | null;
  epsAnalysts: number | null;
  revenueEstimate: number | null;
  revenueAnalysts: number | null;
  implied: EarningsImpliedMove | null;
  realized: EarningsRealizedMove | null;
  /** Whether the date is out, announced or projected; absent from older servers. */
  dateStatus?: EarningsDateStatus;
  /** The reported figure's basis, null when it cannot be determined; absent from older servers. */
  epsBasis?: EarningsEpsBasis | null;
  /** ISO currency of every amount on the report, a listing abroad's (CNY for Tencent); absent for US listings, whose figures are dollars. */
  currency?: string | null;
  /**
   * A listing abroad's board row: the company's lines on its markets, the one
   * shown first (601939:SSE, 0939:HKEX for China Construction Bank). Its
   * market cap is in dollars, as every company's on the board. Absent for US
   * listings.
   */
  listings?: string[];
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
  /** `press-release` until the statements have the quarter, `filing` a listing abroad's results announcement; absent from older servers. */
  revenueActualSource?: "statements" | "press-release" | "filing" | null;
  /** The fiscal quarter as the company names it, null when its calls do not say; absent from older servers. */
  fiscalYear?: number | null;
  fiscalQuarter?: number | null;
  /**
   * What the figures cover, a listing abroad's: a half-yearly reporter's
   * half is a half, never a quarter. Absent (a quarter) for US listings.
   * `fiscalYear` is then the year it falls in, named by the calendar year
   * that year ends in, and `fiscalHalf` a half's number.
   */
  periodKind?: EarningsPeriodKind;
  periodMonths?: number;
  fiscalHalf?: number | null;
  /** The results announcement the figures were read from, a listing abroad's. */
  filing?: { url: string; title: string; publishedAt: string } | null;
  /**
   * A listing abroad's filed EPS's dilution: a basic EPS has no basis (it is
   * not the statements' diluted figure) and says so here. Null or absent otherwise.
   */
  epsDilution?: "diluted" | "basic" | null;
}

/** One report whose fiscal quarter the company's calls name: every other quarter steps from it. */
export interface EarningsFiscalAnchor {
  /** The quarter's end month, YYYY-MM. */
  fiscalPeriod: string;
  fiscalYear: number;
  fiscalQuarter: number;
}

export interface EarningsHistoryPayload {
  asOf: string;
  symbol: string;
  name: string | null;
  /** Null when the company's calls do not name its quarters; absent from older servers. */
  fiscalAnchor?: EarningsFiscalAnchor | null;
  /** The basis the company's next consensus is on, from its past year's reports; null when they do not agree. Absent from older servers. */
  consensusBasis?: EarningsEpsBasis | null;
  /**
   * Whether a listing abroad's history carries its announcements' figures
   * and links (Pro, as KPIS has them); its street quarters are everyone's.
   * Absent for US listings.
   */
  access?: { pro: boolean };
  /** Newest first; an upcoming report leads. */
  reports: EarningsHistoryReport[];
}

export interface EarningsCalendarQuery {
  from: string;
  to: string;
  /** Largest companies kept per day; the listed symbols are always kept. */
  perDay?: number;
  symbols?: readonly string[];
  /**
   * `all` adds the Hong Kong, China A and Singapore top 100's reports, each
   * in its own currency, and keeps a listing there named in `symbols`
   * (0700:HKEX). Without it the board is US listings'. Only a view that
   * shows each report's currency asks for it.
   */
  markets?: "all";
}
