import type { DataTableColumn } from "../../../components";
import type { SortDirection } from "../../../utils/sort-values";

export type ThirteenFBrowserTab = "funds" | "performance" | "byTicker" | "latest";
export type ThirteenFDetailTab = "holdings" | "filings" | "overlap";
export type LoadStatus = "idle" | "loading" | "loaded" | "error";

export interface ThirteenFFund {
  cik: string;
  name: string;
}

export interface ThirteenFTopFund {
  cik: string;
  name: string;
  periodOfReport: string;
  pnl: number | null;
}

export interface ThirteenFFormSummary {
  url: string;
  accessionNumber: string;
  submissionType: string;
  periodOfReport: string;
  filedAsOfDate: string;
  cik: string;
  companyName: string;
  tableValueTotal: number | null;
  tableEntryTotal: number | null;
  isAmendment: boolean;
  amendmentType?: string;
  /** Set by Gloom Cloud when it restated the filing's values to dollars ("values restated from thousands"). */
  valueNote?: string;
}

export interface ThirteenFHoldingRecord {
  accessionNumber: string;
  cik: string;
  issuer: string;
  titleOfClass: string;
  cusip: string;
  ticker: string;
  value: number | null;
  shares: number | null;
  shareType: string;
  investmentDiscretion: string;
  votingAuthoritySole: number | null;
  votingAuthorityShared: number | null;
  votingAuthorityNone: number | null;
  putCall: string;
}

export interface ThirteenFTickerInfo {
  cusip: string;
  ticker: string;
  companyName: string;
}

export interface ThirteenFTickerHolders {
  cusip: string;
  periodOfReport: string;
  ciks: string[];
}

export interface FundBrowserRow {
  id: string;
  cik: string;
  name: string;
  periodOfReport?: string;
  filedAsOfDate?: string;
  tableValueTotal?: number | null;
  tableEntryTotal?: number | null;
  estQuarterReturn?: number | null;
  priorReturns?: Array<{ quarter: string; value: number | null }>;
  source: "funds" | "performance" | "ticker" | "latest";
}

export type FundBrowserColumnId =
  | "fund"
  | "cik"
  | "period"
  | "filed"
  | "value"
  | "rows"
  | "estQuarterReturn"
  | "return1" | "return2" | "return3";
export type FundBrowserColumn = DataTableColumn & { id: FundBrowserColumnId };

export interface FundDetailData {
  cik: string;
  name: string;
  forms: ThirteenFFormSummary[];
  latestForm: ThirteenFFormSummary | null;
  previousForm: ThirteenFFormSummary | null;
  latestHoldings: ThirteenFHoldingRecord[];
  previousHoldings: ThirteenFHoldingRecord[];
  latestReport?: ThirteenFPeriodReport;
  previousReport?: ThirteenFPeriodReport;
  warnings?: string[];
  /** Set when the latest report predates the newest quarter past its deadline. */
  filingGap?: ThirteenFFilingGap | null;
}

/** A manager a 13F-NT names as reporting its holdings. */
export interface ThirteenFOtherManager {
  /** Null on a cover page that gives only the 028- file number. */
  cik: string | null;
  name: string;
  fileNumber: string | null;
}

/** One 13F filing as EDGAR lists it, notices included. */
export interface ThirteenFEdgarFiling {
  /** 13F-HR, 13F-HR/A, 13F-NT or 13F-NT/A. */
  form: string;
  period: string;
  filed: string;
  accession: string;
  url: string;
  otherManagers?: ThirteenFOtherManager[];
}

/** A filer's 13F filings from EDGAR, newest first. */
export interface ThirteenFFilerStatus {
  cik: string;
  name: string;
  source: string;
  filings: ThirteenFEdgarFiling[];
}

/**
 * What a fund filed for the newest quarter past its deadline when no holdings
 * report for it is loaded: a 13F-NT (another manager reported the holdings), a
 * report EDGAR has that is not loaded yet, or nothing EDGAR shows.
 */
export interface ThirteenFFilingGap {
  /** The quarter end, YYYY-MM-DD. */
  period: string;
  /** The day the 13F was due, YYYY-MM-DD. */
  due: string;
  /** The fund's own filing for that quarter, when EDGAR lists one. */
  filing: ThirteenFEdgarFiling | null;
  /** False when EDGAR could not be asked; a missing filing is then as far as the loaded reports know. */
  checked: boolean;
}

/** The public report for one period, after applying known amendment types. */
export interface ThirteenFPeriodReport {
  periodOfReport: string;
  filings: ThirteenFFormSummary[];
  complete: boolean;
  tableValueTotal: number | null;
  tableEntryTotal: number | null;
}

export type HoldingAction = "held" | "new" | "add" | "trim" | "exit" | "unknown";

export interface FundHoldingRow {
  mine?: boolean;
  id: string;
  ticker: string;
  issuer: string;
  cusip: string;
  titleOfClass: string;
  putCall: string;
  shareType: string;
  value: number | null;
  shares: number | null;
  weight: number | null;
  previousValue: number | null;
  previousShares: number | null;
  valueChange: number | null;
  estimatedPnl: number | null;
  /** New shares per old (10 for 10:1) when the filings straddle a split its corporate actions show: Est P&L is priced, and sharesChange, sharesChangePercent and action measured, on the previous shares carried across it. */
  splitRatio?: number;
  /** The line moved as across a split and its corporate actions could not be read to tell: Est P&L is left empty, not priced as a crash or a surge, and its share change stays as filed. */
  splitUnread?: boolean;
  sharesChange: number | null;
  sharesChangePercent: number | null;
  action: HoldingAction;
  accessionNumber: string;
}

export type FundHoldingColumnId =
  | "mine"
  | "ticker"
  | "type"
  | "issuer"
  | "value"
  | "estimatedPnl"
  | "weight"
  | "shares"
  | "sharesChange"
  | "action";
export type FundHoldingColumn = DataTableColumn & { id: FundHoldingColumnId };

export interface FilingPositionRow {
  id: string;
  ticker: string;
  issuer: string;
  cusip: string;
  titleOfClass: string;
  putCall: string;
  shareType: string;
  value: number | null;
  shares: number | null;
  weight: number | null;
  investmentDiscretion: string;
  votingAuthoritySole: number | null;
  votingAuthorityShared: number | null;
  votingAuthorityNone: number | null;
  accessionNumber: string;
}

export type FilingPositionColumnId =
  | "ticker"
  | "type"
  | "issuer"
  | "value"
  | "weight"
  | "shares"
  | "cusip"
  | "discretion";
export type FilingPositionColumn = DataTableColumn & { id: FilingPositionColumnId };

export interface FundTimelineRow {
  id: string;
  cik: string;
  companyName: string;
  periodOfReport: string;
  filedAsOfDate: string;
  accessionNumber: string;
  submissionType: string;
  amendmentType?: string;
  tableValueTotal: number | null;
  tableEntryTotal: number | null;
  valueChangePercent: number | null;
  isAmendment: boolean;
  url: string;
}

export type FundTimelineColumnId =
  | "period"
  | "filed"
  | "value"
  | "rows"
  | "valueChange"
  | "form";
export type FundTimelineColumn = DataTableColumn & { id: FundTimelineColumnId };

export type FundSortPreference<TColumn extends string> = {
  columnId: TColumn;
  direction: SortDirection;
};
