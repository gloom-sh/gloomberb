import { compareSortValues } from "../../../utils/sort-values";
import type {
  FilingPositionColumn,
  FilingPositionColumnId,
  FilingPositionRow,
  FundBrowserColumn,
  FundBrowserColumnId,
  FundBrowserRow,
  FundDetailData,
  FundHoldingColumn,
  FundHoldingColumnId,
  FundHoldingRow,
  FundSortPreference,
  FundTimelineColumn,
  FundTimelineColumnId,
  FundTimelineRow,
  HoldingAction,
  SortDirection,
  ThirteenFBrowserTab,
  ThirteenFDetailTab,
  ThirteenFFormSummary,
  ThirteenFFund,
  ThirteenFHoldingRecord,
  ThirteenFTopFund,
  ThirteenFPeriodReport,
} from "./types";

export const THIRTEENF_PANE_ID = "thirteenf-funds";
export const THIRTEENF_TEMPLATE_ID = "thirteenf-funds-pane";
export const THIRTEENF_OPTIONS_NOTE = "Option values and shares refer to the underlying; 13F % is share of reported value.";

export const FUND_DETAIL_TABS: Array<{ label: string; value: ThirteenFDetailTab }> = [
  { label: "Holdings", value: "holdings" },
  { label: "Filings", value: "filings" },
];

export const DEFAULT_BROWSER_SORT: FundSortPreference<FundBrowserColumnId> = {
  columnId: "estQuarterReturn",
  direction: "desc",
};

export const DEFAULT_HOLDING_SORT: FundSortPreference<FundHoldingColumnId> = {
  columnId: "value",
  direction: "desc",
};

export const DEFAULT_TIMELINE_SORT: FundSortPreference<FundTimelineColumnId> = {
  columnId: "period",
  direction: "desc",
};

export const DEFAULT_FILING_POSITION_SORT: FundSortPreference<FilingPositionColumnId> = {
  columnId: "value",
  direction: "desc",
};

const TICKER_LIKE_RE = /^[A-Z][A-Z0-9.-]{0,5}$/;
const CIK_RE = /^\d{6,10}$/;

export function inferBrowserTabFromQuery(query: string): ThirteenFBrowserTab {
  const trimmed = query.trim();
  if (!trimmed) return "performance";
  // The recent-filings feed has no tab of its own; this keyword is how it is reached.
  if (/^(latest|recent)$/i.test(trimmed)) return "latest";
  if (!/[a-z]/.test(trimmed) && TICKER_LIKE_RE.test(trimmed.replace(/^\$/, "").toUpperCase())) return "byTicker";
  return "funds";
}

export function normalizeQuarterDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}Q${quarter}`;
}

export function latestLikely13FQuarter(now = new Date()): string {
  const currentQuarterStart = Math.floor(now.getUTCMonth() / 3) * 3;
  // Allow the provider's existing 50-day reporting buffer, including January
  // when the latest broadly available filing period is the previous Q3.
  for (let offset = 0; offset < 8; offset += 1) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), currentQuarterStart - offset * 3, 0));
    if (end.getTime() + 50 * 86_400_000 <= now.getTime()) return normalizeQuarterDate(end);
  }
  return "";
}

export function dateYearsAgo(years: number, now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

export function todayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

export function recentIso(days: number, now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days))
    .toISOString()
    .slice(0, 10);
}

export function buildBrowserRows(options: {
  funds?: ThirteenFFund[];
  topFunds?: ThirteenFTopFund[];
  forms?: Map<string, ThirteenFFormSummary>;
  latestFilings?: ThirteenFFormSummary[];
  source: FundBrowserRow["source"];
}): FundBrowserRow[] {
  if (options.latestFilings) {
    return dedupeLatestForms(options.latestFilings).map((form) => ({
      id: `${options.source}:${form.cik}`,
      cik: form.cik,
      name: form.companyName || form.cik,
      periodOfReport: form.periodOfReport,
      filedAsOfDate: form.filedAsOfDate,
      tableValueTotal: form.tableValueTotal,
      tableEntryTotal: form.tableEntryTotal,
      source: options.source,
    }));
  }

  const topByCik = new Map((options.topFunds ?? []).map((fund) => [fund.cik, fund]));
  const funds = options.funds ?? options.topFunds ?? [];
  return funds.map((fund) => {
    const topFund = topByCik.get(fund.cik);
    const latestForm = options.forms?.get(fund.cik);
    // Performance belongs to its supplied quarter; a later (or stale) filing
    // cannot supply that quarter's portfolio value or filing date.
    const periodOfReport = options.source === "performance"
      ? topFund?.periodOfReport ?? latestForm?.periodOfReport
      : latestForm?.periodOfReport ?? topFund?.periodOfReport;
    const form = latestForm?.periodOfReport === periodOfReport ? latestForm : undefined;
    return {
      id: `${options.source}:${fund.cik}`,
      cik: fund.cik,
      name: fund.name,
      periodOfReport,
      filedAsOfDate: form?.filedAsOfDate,
      tableValueTotal: form?.tableValueTotal,
      tableEntryTotal: form?.tableEntryTotal,
      estQuarterReturn: topFund && topFund.periodOfReport === periodOfReport ? topFund.pnl : null,
      source: options.source,
    };
  });
}

export function dedupeLatestForms(forms: ThirteenFFormSummary[]): ThirteenFFormSummary[] {
  const byCik = new Map<string, ThirteenFFormSummary>();
  for (const form of forms) {
    const current = byCik.get(form.cik);
    if (!current || compareFormRecency(form, current) > 0) {
      byCik.set(form.cik, form);
    }
  }
  return [...byCik.values()].sort((left, right) => compareFormRecency(right, left));
}

/** SEC Form 13F special instruction 3: restatements replace the report;
 * NEW HOLDINGS filings add entries to the existing public report. Row counts
 * cannot establish which kind of amendment a filer submitted. */
export function buildPeriodReports(forms: ThirteenFFormSummary[]): ThirteenFPeriodReport[] {
  const byPeriod = new Map<string, ThirteenFPeriodReport>();
  const unique = [...new Map(forms.map((form) => [form.accessionNumber, form])).values()];
  for (const form of unique.sort(compareFormRecency)) {
    let report = byPeriod.get(form.periodOfReport);
    const amendmentType = form.amendmentType?.trim().toUpperCase();
    if (!form.isAmendment || amendmentType === "RESTATEMENT") {
      report = { periodOfReport: form.periodOfReport, filings: [form], complete: true,
        tableValueTotal: form.tableValueTotal, tableEntryTotal: form.tableEntryTotal };
    } else if (amendmentType === "NEW HOLDINGS") {
      report = report ?? { periodOfReport: form.periodOfReport, filings: [], complete: false,
        tableValueTotal: null, tableEntryTotal: null };
      report.filings.push(form);
      report.tableValueTotal = addKnown(report.tableValueTotal, form.tableValueTotal);
      report.tableEntryTotal = addKnown(report.tableEntryTotal, form.tableEntryTotal);
    } else {
      // An untyped amendment could replace or supplement the report. Display
      // its disclosed entries without inventing a reconciled full portfolio.
      report = { periodOfReport: form.periodOfReport, filings: [form], complete: false,
        tableValueTotal: null, tableEntryTotal: null };
    }
    byPeriod.set(form.periodOfReport, report);
  }
  return [...byPeriod.values()].sort((left, right) => right.periodOfReport.localeCompare(left.periodOfReport));
}

function addKnown(left: number | null, right: number | null): number | null {
  return left != null && right != null ? left + right : null;
}

function compareFormRecency(left: ThirteenFFormSummary, right: ThirteenFFormSummary): number {
  const period = left.periodOfReport.localeCompare(right.periodOfReport);
  if (period !== 0) return period;
  const filed = left.filedAsOfDate.localeCompare(right.filedAsOfDate);
  if (filed !== 0) return filed;
  return left.accessionNumber.localeCompare(right.accessionNumber);
}

interface HoldingAggregate {
  id: string;
  ticker: string;
  issuer: string;
  cusip: string;
  titleOfClass: string;
  putCall: string;
  shareType: string;
  value: number | null;
  shares: number | null;
  accessionNumber: string;
}

function holdingKey(holding: ThirteenFHoldingRecord): string {
  return [
    holding.cusip.trim().toUpperCase(),
    holding.putCall.trim().toUpperCase(),
    holding.shareType.trim().toUpperCase(),
  ].join("|");
}

function aggregateHoldings(holdings: ThirteenFHoldingRecord[]): Map<string, HoldingAggregate> {
  const aggregates = new Map<string, HoldingAggregate>();
  for (const holding of holdings) {
    const id = holdingKey(holding);
    const current = aggregates.get(id);
    const value = holding.value;
    const shares = holding.shares;
    if (current) {
      current.value = addKnown(current.value, value);
      current.shares = addKnown(current.shares, shares);
      if (!current.ticker && holding.ticker) current.ticker = holding.ticker;
      continue;
    }
    aggregates.set(id, {
      id,
      ticker: holding.ticker,
      issuer: holding.issuer,
      cusip: holding.cusip,
      titleOfClass: holding.titleOfClass,
      putCall: holding.putCall,
      shareType: holding.shareType,
      value,
      shares,
      accessionNumber: holding.accessionNumber,
    });
  }
  return aggregates;
}

function resolveAction(current: HoldingAggregate | undefined, previous: HoldingAggregate | undefined): HoldingAction {
  if (current && !previous) return "new";
  if (!current && previous) return "exit";
  if (!current || !previous) return "held";
  if (current.shares == null || previous.shares == null) return "unknown";
  const delta = current.shares - previous.shares;
  if (delta > 0) return "add";
  if (delta < 0) return "trim";
  return "held";
}

function estimateHoldingPnl(
  current: HoldingAggregate | undefined,
  previous: HoldingAggregate | undefined,
): number | null {
  if (!current || !previous) return null;
  // A 13F option value is underlying notional. Its change cannot price the
  // option, and the filing does not identify strike, expiry or premium.
  if (current.putCall || previous.putCall) return null;
  if (current.value == null || previous.value == null || current.value <= 0 || previous.value <= 0) return null;
  if (current.shares == null || previous.shares == null || current.shares <= 0 || previous.shares <= 0) return null;

  const currentPrice = current.value / current.shares;
  const previousPrice = previous.value / previous.shares;
  const overlappingShares = Math.min(current.shares, previous.shares);
  return (currentPrice - previousPrice) * overlappingShares;
}

export function hasComparable13FQuarter(data: FundDetailData): boolean {
  if (data.latestReport?.complete === false || data.previousReport?.complete === false) return false;
  const current = data.latestForm?.periodOfReport;
  const previous = data.previousForm?.periodOfReport;
  return adjacentQuarterPeriods(current, previous);
}

function adjacentQuarterPeriods(current: string | undefined, previous: string | undefined): boolean {
  if (!current || !previous) return false;
  const date = new Date(`${current}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return false;
  const priorEnd = new Date(Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3, 0));
  return previous === priorEnd.toISOString().slice(0, 10);
}

export function buildFundHoldingRows(data: FundDetailData | null): FundHoldingRow[] {
  if (!data?.latestForm) return [];
  const current = aggregateHoldings(data.latestHoldings);
  const comparable = hasComparable13FQuarter(data);
  const previous = aggregateHoldings(comparable ? data.previousHoldings : []);
  const allKeys = new Set([...current.keys(), ...previous.keys()]);
  const totalValue = data.latestReport
    ? data.latestReport.complete ? data.latestReport.tableValueTotal : null
    : data.latestForm.tableValueTotal;

  return [...allKeys].map((id) => {
    const currentHolding = current.get(id);
    const previousHolding = previous.get(id);
    const display = currentHolding ?? previousHolding!;
    const value = currentHolding?.value ?? null;
    const shares = currentHolding?.shares ?? null;
    const previousValue = previousHolding?.value ?? null;
    const previousShares = previousHolding?.shares ?? null;
    const valueChange = comparable && (!currentHolding || value != null) && (!previousHolding || previousValue != null)
      ? (value ?? 0) - (previousValue ?? 0)
      : null;
    const sharesChange = comparable && (!currentHolding || shares != null) && (!previousHolding || previousShares != null)
      ? (shares ?? 0) - (previousShares ?? 0)
      : null;
    const sharesChangePercent = sharesChange != null && previousShares && previousShares !== 0
      ? sharesChange / previousShares
      : null;
    return {
      id,
      ticker: display.ticker,
      issuer: display.issuer,
      cusip: display.cusip,
      titleOfClass: display.titleOfClass,
      putCall: display.putCall,
      shareType: display.shareType,
      value,
      shares,
      weight: value != null && totalValue ? value / totalValue : null,
      previousValue,
      previousShares,
      valueChange,
      estimatedPnl: estimateHoldingPnl(currentHolding, previousHolding),
      sharesChange,
      sharesChangePercent,
      action: comparable ? resolveAction(currentHolding, previousHolding) : "unknown",
      accessionNumber: display.accessionNumber,
    };
  });
}

export function buildFilingPositionRows(
  holdings: ThirteenFHoldingRecord[],
  reportedTotalValue?: number | null,
): FilingPositionRow[] {
  // Filing details are paginated; the loaded page cannot supply a full-report denominator.
  const totalValue = reportedTotalValue;
  return holdings.map((holding, index) => ({
    id: [
      holding.accessionNumber,
      holding.cusip,
      holding.ticker,
      holding.putCall,
      holding.titleOfClass,
      holding.shareType,
      index,
    ].join("|"),
    ticker: holding.ticker,
    issuer: holding.issuer,
    cusip: holding.cusip,
    titleOfClass: holding.titleOfClass,
    putCall: holding.putCall,
    shareType: holding.shareType,
    value: holding.value,
    shares: holding.shares,
    weight: holding.value != null && totalValue ? holding.value / totalValue : null,
    investmentDiscretion: holding.investmentDiscretion,
    votingAuthoritySole: holding.votingAuthoritySole,
    votingAuthorityShared: holding.votingAuthorityShared,
    votingAuthorityNone: holding.votingAuthorityNone,
    accessionNumber: holding.accessionNumber,
  }));
}

export function buildTimelineRows(forms: ThirteenFFormSummary[]): FundTimelineRow[] {
  const reports = buildPeriodReports(forms);
  const selected = [...new Map(forms.map((form) => [form.accessionNumber, form])).values()]
    .sort((left, right) => compareFormRecency(right, left));
  return selected.map((form) => {
    const index = reports.findIndex((report) => report.periodOfReport === form.periodOfReport);
    const report = reports[index];
    const previous = reports[index + 1];
    // A single filing's value is not the combined value of an amended period.
    // Keep every source filing visible, and compare only full adjacent reports.
    const comparable = report?.complete && report.filings.length === 1
      && report.filings[0]?.accessionNumber === form.accessionNumber
      && previous?.complete && adjacentQuarterPeriods(form.periodOfReport, previous.periodOfReport);
    const valueChangePercent = comparable && form.tableValueTotal != null
      && previous.tableValueTotal != null && previous.tableValueTotal !== 0
      ? (form.tableValueTotal - previous.tableValueTotal) / previous.tableValueTotal
      : null;
    return {
      id: form.accessionNumber,
      cik: form.cik,
      companyName: form.companyName,
      periodOfReport: form.periodOfReport,
      filedAsOfDate: form.filedAsOfDate,
      accessionNumber: form.accessionNumber,
      submissionType: form.submissionType,
      amendmentType: form.amendmentType,
      tableValueTotal: form.tableValueTotal,
      tableEntryTotal: form.tableEntryTotal,
      valueChangePercent,
      isAmendment: form.isAmendment,
      url: form.url,
    };
  });
}

function browserSortValue(row: FundBrowserRow, columnId: FundBrowserColumnId): string | number | null {
  switch (columnId) {
    case "fund":
      return row.name;
    case "cik":
      return row.cik;
    case "period":
      return row.periodOfReport ?? null;
    case "filed":
      return row.filedAsOfDate ?? null;
    case "value":
      return row.tableValueTotal ?? null;
    case "rows":
      return row.tableEntryTotal ?? null;
    case "estQuarterReturn":
      return row.estQuarterReturn ?? null;
  }
}

function holdingSortValue(row: FundHoldingRow, columnId: FundHoldingColumnId): string | number | null {
  switch (columnId) {
    case "ticker":
      return row.ticker || row.cusip;
    case "type":
      return row.putCall || row.titleOfClass || row.shareType || null;
    case "issuer":
      return row.issuer;
    case "value":
      return row.value ?? null;
    case "estimatedPnl":
      return row.estimatedPnl ?? null;
    case "weight":
      return row.weight ?? null;
    case "shares":
      return row.shares ?? null;
    case "sharesChange":
      return row.sharesChange ?? null;
    case "action":
      return row.action;
  }
}

function timelineSortValue(row: FundTimelineRow, columnId: FundTimelineColumnId): string | number | null {
  switch (columnId) {
    case "period":
      return row.periodOfReport;
    case "filed":
      return row.filedAsOfDate;
    case "value":
      return row.tableValueTotal ?? null;
    case "rows":
      return row.tableEntryTotal ?? null;
    case "valueChange":
      return row.valueChangePercent ?? null;
    case "form":
      return row.submissionType;
  }
}

function filingPositionSortValue(row: FilingPositionRow, columnId: FilingPositionColumnId): string | number | null {
  switch (columnId) {
    case "ticker":
      return row.ticker || row.cusip;
    case "type":
      return row.putCall || row.titleOfClass || row.shareType || null;
    case "issuer":
      return row.issuer;
    case "value":
      return row.value ?? null;
    case "weight":
      return row.weight ?? null;
    case "shares":
      return row.shares ?? null;
    case "cusip":
      return row.cusip;
    case "discretion":
      return row.investmentDiscretion || null;
  }
}

export function sortBrowserRows(
  rows: FundBrowserRow[],
  preference: FundSortPreference<FundBrowserColumnId>,
): FundBrowserRow[] {
  return [...rows].sort((left, right) => {
    const comparison = compareSortValues(
      browserSortValue(left, preference.columnId),
      browserSortValue(right, preference.columnId),
      preference.direction,
    );
    if (comparison !== 0) return comparison;
    return left.name.localeCompare(right.name);
  });
}

export function sortFilingPositionRows(
  rows: FilingPositionRow[],
  preference: FundSortPreference<FilingPositionColumnId>,
): FilingPositionRow[] {
  return [...rows].sort((left, right) => {
    const comparison = compareSortValues(
      filingPositionSortValue(left, preference.columnId),
      filingPositionSortValue(right, preference.columnId),
      preference.direction,
    );
    if (comparison !== 0) return comparison;
    return (left.ticker || left.issuer).localeCompare(right.ticker || right.issuer);
  });
}

export function sortHoldingRows(
  rows: FundHoldingRow[],
  preference: FundSortPreference<FundHoldingColumnId>,
): FundHoldingRow[] {
  return [...rows].sort((left, right) => {
    const comparison = compareSortValues(
      holdingSortValue(left, preference.columnId),
      holdingSortValue(right, preference.columnId),
      preference.direction,
    );
    if (comparison !== 0) return comparison;
    return (left.ticker || left.issuer).localeCompare(right.ticker || right.issuer);
  });
}

export function sortTimelineRows(
  rows: FundTimelineRow[],
  preference: FundSortPreference<FundTimelineColumnId>,
): FundTimelineRow[] {
  return [...rows].sort((left, right) => compareSortValues(
    timelineSortValue(left, preference.columnId),
    timelineSortValue(right, preference.columnId),
    preference.direction,
  ));
}

export function nextSortPreference<TColumn extends string>(
  current: FundSortPreference<TColumn>,
  columnId: TColumn,
  defaultDirection: SortDirection,
): FundSortPreference<TColumn> {
  if (current.columnId !== columnId) return { columnId, direction: defaultDirection };
  return {
    columnId,
    direction: current.direction === "asc" ? "desc" : "asc",
  };
}

export function buildBrowserColumns(width: number): FundBrowserColumn[] {
  const cikWidth = 12;
  const periodWidth = 10;
  const filedWidth = 9;
  const valueWidth = 11;
  const rowsWidth = 6;
  const retWidth = 9;
  const fixedWidth = cikWidth + periodWidth + filedWidth + valueWidth + rowsWidth + retWidth;
  const separators = 7;
  const fundWidth = Math.max(18, width - fixedWidth - separators - 2);
  return [
    { id: "fund", label: "FUND", width: fundWidth, align: "left" },
    { id: "cik", label: "CIK", width: cikWidth, align: "left" },
    { id: "period", label: "PERIOD", width: periodWidth, align: "left" },
    ...(retWidth > 0 ? [{ id: "estQuarterReturn" as const, label: "EST 13F", width: retWidth, align: "right" as const }] : []),
    { id: "value", label: "VALUE", width: valueWidth, align: "right" },
    { id: "rows", label: "ROWS", width: rowsWidth, align: "right" },
    { id: "filed", label: "FILED", width: filedWidth, align: "left" },
  ];
}

export function buildFilingPositionColumns(width: number): FilingPositionColumn[] {
  const tickerWidth = 9;
  const typeWidth = 8;
  const valueWidth = 12;
  const weightWidth = 8;
  const sharesWidth = 11;
  const cusipWidth = 10;
  const discretionWidth = 8;
  const fixedWidth = tickerWidth + typeWidth + valueWidth + weightWidth + sharesWidth + cusipWidth + discretionWidth;
  const issuerWidth = Math.max(16, width - fixedWidth - 9);
  return [
    { id: "ticker", label: "TICKER", width: tickerWidth, align: "left" },
    { id: "type", label: "TYPE", width: typeWidth, align: "left" },
    { id: "issuer", label: "ISSUER", width: issuerWidth, align: "left" },
    { id: "value", label: "VALUE", width: valueWidth, align: "right" },
    { id: "weight", label: "13F %", width: weightWidth, align: "right" },
    { id: "shares", label: "SHARES", width: sharesWidth, align: "right" },
    { id: "cusip", label: "CUSIP", width: cusipWidth, align: "left" },
    { id: "discretion", label: "DISCR", width: discretionWidth, align: "left" },
  ];
}

export function buildHoldingColumns(width: number): FundHoldingColumn[] {
  const tickerWidth = 9;
  const typeWidth = 8;
  const valueWidth = 12;
  const pnlWidth = 12;
  const weightWidth = 8;
  const sharesWidth = 11;
  const changeWidth = 11;
  const actionWidth = 7;
  const fixedWidth = tickerWidth + typeWidth + valueWidth + pnlWidth + weightWidth + sharesWidth + changeWidth + actionWidth;
  const issuerWidth = Math.max(18, width - fixedWidth - 10);
  return [
    { id: "ticker", label: "TICKER", width: tickerWidth, align: "left" },
    { id: "type", label: "TYPE", width: typeWidth, align: "left" },
    { id: "issuer", label: "ISSUER", width: issuerWidth, align: "left" },
    { id: "value", label: "VALUE", width: valueWidth, align: "right" },
    { id: "estimatedPnl", label: "EST P&L", width: pnlWidth, align: "right" },
    { id: "weight", label: "13F %", width: weightWidth, align: "right" },
    { id: "shares", label: "SHARES", width: sharesWidth, align: "right" },
    { id: "sharesChange", label: "QOQ", width: changeWidth, align: "right" },
    { id: "action", label: "ACTION", width: actionWidth, align: "left" },
  ];
}

export function buildTimelineColumns(width: number): FundTimelineColumn[] {
  const periodWidth = 10;
  const filedWidth = 9;
  const valueWidth = 12;
  const rowsWidth = 6;
  const changeWidth = 9;
  const formWidth = Math.max(10, width - periodWidth - filedWidth - valueWidth - rowsWidth - changeWidth - 7);
  return [
    { id: "period", label: "PERIOD", width: periodWidth, align: "left" },
    { id: "filed", label: "FILED", width: filedWidth, align: "left" },
    { id: "value", label: "VALUE", width: valueWidth, align: "right" },
    { id: "rows", label: "ROWS", width: rowsWidth, align: "right" },
    { id: "valueChange", label: "VALUE%", width: changeWidth, align: "right" },
    { id: "form", label: "FORM", width: formWidth, align: "left" },
  ];
}

export function selectedIndexById<T extends { id: string }>(rows: T[], selectedId: string | null): number {
  const index = rows.findIndex((row) => row.id === selectedId);
  return index >= 0 ? index : rows.length > 0 ? 0 : -1;
}

export function positionType(row: {
  putCall: string;
  titleOfClass: string;
  shareType: string;
}): string {
  const putCall = row.putCall.trim().toUpperCase();
  if (putCall === "PUT" || putCall === "CALL") return putCall;
  const title = row.titleOfClass.trim().toUpperCase();
  if (title) return title;
  const shareType = row.shareType.trim().toUpperCase();
  return shareType || "--";
}

export function isCikQuery(query: string): boolean {
  return CIK_RE.test(query.trim());
}
