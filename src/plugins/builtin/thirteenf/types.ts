import type { DataTableColumn } from "../../../components";

export type ThirteenFBrowserTab = "funds" | "performance" | "byTicker" | "latest";
export type ThirteenFDetailTab = "holdings" | "filings";
export type LoadStatus = "idle" | "loading" | "loaded" | "error";
export type SortDirection = "asc" | "desc";

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
  source: "funds" | "performance" | "ticker" | "latest";
}

export type FundBrowserColumnId =
  | "fund"
  | "cik"
  | "period"
  | "filed"
  | "value"
  | "rows"
  | "estQuarterReturn";
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
  sharesChange: number | null;
  sharesChangePercent: number | null;
  action: HoldingAction;
  accessionNumber: string;
}

export type FundHoldingColumnId =
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
