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
} from "./types";

export const THIRTEENF_PANE_ID = "thirteenf-funds";
export const THIRTEENF_TEMPLATE_ID = "thirteenf-funds-pane";

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
  const year = now.getUTCFullYear();
  const quarterEnds = [
    Date.UTC(year - 1, 11, 31),
    Date.UTC(year, 2, 31),
    Date.UTC(year, 5, 30),
    Date.UTC(year, 8, 30),
    Date.UTC(year, 11, 31),
  ];
  const availableAt = quarterEnds
    .map((timestamp) => timestamp + 50 * 24 * 60 * 60_000)
    .filter((timestamp) => timestamp <= now.getTime())
    .at(-1) ?? quarterEnds[0]!;
  return normalizeQuarterDate(new Date(availableAt - 50 * 24 * 60 * 60_000));
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
    const form = options.forms?.get(fund.cik);
    return {
      id: `${options.source}:${fund.cik}`,
      cik: fund.cik,
      name: fund.name,
      periodOfReport: form?.periodOfReport ?? topFund?.periodOfReport,
      filedAsOfDate: form?.filedAsOfDate,
      tableValueTotal: form?.tableValueTotal,
      tableEntryTotal: form?.tableEntryTotal,
      estQuarterReturn: topFund?.pnl ?? null,
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

export function selectLatestFormsByPeriod(forms: ThirteenFFormSummary[]): ThirteenFFormSummary[] {
  const byPeriod = new Map<string, ThirteenFFormSummary>();
  for (const form of forms) {
    const current = byPeriod.get(form.periodOfReport);
    if (!current || shouldReplacePeriodForm(current, form)) {
      byPeriod.set(form.periodOfReport, form);
    }
  }
  return [...byPeriod.values()].sort((left, right) => compareFormPeriod(right, left));
}

function isSupplementalAmendment(form: ThirteenFFormSummary): boolean {
  if (!form.isAmendment) return false;
  const amendmentType = form.amendmentType?.toUpperCase() ?? "";
  return amendmentType.length > 0 && amendmentType !== "RESTATEMENT";
}

function shouldReplacePeriodForm(current: ThirteenFFormSummary, candidate: ThirteenFFormSummary): boolean {
  if (isSupplementalAmendment(candidate) && !isSupplementalAmendment(current)) return false;
  if (!isSupplementalAmendment(candidate) && isSupplementalAmendment(current)) return true;
  if (candidate.isAmendment && !current.isAmendment) {
    const candidateRows = candidate.tableEntryTotal ?? 0;
    const currentRows = current.tableEntryTotal ?? 0;
    if (currentRows > 0 && candidateRows < currentRows * 0.75) return false;
  }
  return compareFormRecency(candidate, current) > 0;
}

function compareFormPeriod(left: ThirteenFFormSummary, right: ThirteenFFormSummary): number {
  return left.periodOfReport.localeCompare(right.periodOfReport);
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
  value: number;
  shares: number;
  accessionNumber: string;
}

function holdingKey(holding: ThirteenFHoldingRecord): string {
  return [
    holding.ticker || "NO-TICKER",
    holding.cusip,
    holding.putCall || "",
    holding.titleOfClass || "",
  ].join("|");
}

function aggregateHoldings(holdings: ThirteenFHoldingRecord[]): Map<string, HoldingAggregate> {
  const aggregates = new Map<string, HoldingAggregate>();
  for (const holding of holdings) {
    const id = holdingKey(holding);
    const current = aggregates.get(id);
    const value = holding.value ?? 0;
    const shares = holding.shares ?? 0;
    if (current) {
      current.value += value;
      current.shares += shares;
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
  if (current.value <= 0 || previous.value <= 0) return null;
  if (current.shares <= 0 || previous.shares <= 0) return null;

  const currentPrice = current.value / current.shares;
  const previousPrice = previous.value / previous.shares;
  const overlappingShares = Math.min(current.shares, previous.shares);
  return (currentPrice - previousPrice) * overlappingShares;
}

export function buildFundHoldingRows(data: FundDetailData | null): FundHoldingRow[] {
  if (!data?.latestForm) return [];
  const current = aggregateHoldings(data.latestHoldings);
  const previous = aggregateHoldings(data.previousHoldings);
  const allKeys = new Set([...current.keys(), ...previous.keys()]);
  const totalValue = data.latestForm.tableValueTotal
    ?? [...current.values()].reduce((sum, item) => sum + item.value, 0);

  return [...allKeys].map((id) => {
    const currentHolding = current.get(id);
    const previousHolding = previous.get(id);
    const display = currentHolding ?? previousHolding!;
    const value = currentHolding?.value ?? null;
    const shares = currentHolding?.shares ?? null;
    const previousValue = previousHolding?.value ?? null;
    const previousShares = previousHolding?.shares ?? null;
    const valueChange = value != null || previousValue != null
      ? (value ?? 0) - (previousValue ?? 0)
      : null;
    const sharesChange = shares != null || previousShares != null
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
      action: resolveAction(currentHolding, previousHolding),
      accessionNumber: display.accessionNumber,
    };
  });
}

export function buildFilingPositionRows(
  holdings: ThirteenFHoldingRecord[],
  reportedTotalValue?: number | null,
): FilingPositionRow[] {
  const computedTotalValue = holdings.reduce((sum, holding) => sum + (holding.value ?? 0), 0);
  const totalValue = reportedTotalValue ?? computedTotalValue;
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
  const selected = selectLatestFormsByPeriod(forms);
  return selected.map((form, index) => {
    const previous = selected[index + 1];
    const valueChangePercent = form.tableValueTotal != null
      && previous?.tableValueTotal != null
      && previous.tableValueTotal !== 0
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
    { id: "weight", label: "WEIGHT", width: weightWidth, align: "right" },
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
    { id: "weight", label: "WEIGHT", width: weightWidth, align: "right" },
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
