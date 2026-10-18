import { compareSortValues } from "../../../utils/sort-values";
import { zonedDateKey } from "../../../utils/zoned-date-time";
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
  ThirteenFBrowserTab,
  ThirteenFDetailTab,
  ThirteenFFilerStatus,
  ThirteenFFilingGap,
  ThirteenFFormSummary,
  ThirteenFFund,
  ThirteenFHoldingRecord,
  ThirteenFTopFund,
  ThirteenFPeriodReport,
} from "./types";

export const THIRTEENF_PANE_ID = "thirteenf-funds";
export const THIRTEENF_TEMPLATE_ID = "thirteenf-funds-pane";

export const FUND_DETAIL_TABS: Array<{ label: string; value: ThirteenFDetailTab }> = [
  { label: "Holdings", value: "holdings" },
  { label: "Filings", value: "filings" },
  { label: "Overlap", value: "overlap" },
];

export const DEFAULT_BROWSER_SORT: FundSortPreference<FundBrowserColumnId> = {
  columnId: "estQuarterReturn",
  direction: "desc",
};

const RETURN_SORT_COLUMNS = new Set<FundBrowserColumnId>(["estQuarterReturn", "return1", "return2", "return3"]);

/** Estimated returns exist only on the performance ranking; other lists sort by reported value instead. */
export function browserSortFor(
  preference: FundSortPreference<FundBrowserColumnId>,
  tab: ThirteenFBrowserTab,
): FundSortPreference<FundBrowserColumnId> {
  return tab !== "performance" && RETURN_SORT_COLUMNS.has(preference.columnId)
    ? { columnId: "value", direction: "desc" }
    : preference;
}

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

/**
 * A word shaped like a ticker in any case (aapl, BRK.B, brk-b), for a report
 * that tries it as a ticker before a fund name. The pane's live search keeps
 * lowercase words for fund names (`inferBrowserTabFromQuery`).
 */
export function isTickerShapedQuery(query: string): boolean {
  const trimmed = query.trim();
  return !CIK_RE.test(trimmed) && !/^(latest|recent)$/i.test(trimmed)
    && TICKER_LIKE_RE.test(trimmed.replace(/^\$/, "").toUpperCase());
}

export function inferBrowserTabFromQuery(query: string): ThirteenFBrowserTab {
  const trimmed = query.trim();
  if (!trimmed) return "performance";
  // The recent-filings feed has no tab of its own; this keyword is how it is reached.
  if (/^(latest|recent)$/i.test(trimmed)) return "latest";
  if (!/[a-z]/.test(trimmed) && TICKER_LIKE_RE.test(trimmed.replace(/^\$/, "").toUpperCase())) return "byTicker";
  return "funds";
}

function normalizeQuarterDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}Q${quarter}`;
}

const DUE_DAYS = 45;

/** The third Monday of February, a federal holiday a February deadline can fall on. */
function presidentsDay(year: number): number {
  const first = new Date(Date.UTC(year, 1, 1)).getUTCDay();
  return 1 + ((8 - first) % 7) + 14;
}

/**
 * The day a quarter's 13F is due: 45 days after the quarter ends, moved past a
 * weekend, and past Presidents' Day, the one federal holiday a 13F deadline
 * (14 Feb, 15 May, 14 Aug, 14 Nov) can roll onto.
 */
export function thirteenFDueDate(period: string): string {
  const due = new Date(`${period}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + DUE_DAYS);
  for (;;) {
    const day = due.getUTCDay();
    const holiday = due.getUTCMonth() === 1 && due.getUTCDate() === presidentsDay(due.getUTCFullYear());
    if (day !== 0 && day !== 6 && !holiday) break;
    due.setUTCDate(due.getUTCDate() + 1);
  }
  return due.toISOString().slice(0, 10);
}

/** The newest quarter whose 13F deadline has passed in New York, with that deadline. */
export function newestDueQuarter(now = new Date()): { period: string; due: string } {
  const today = zonedDateKey(now.getTime(), "America/New_York");
  const month = Number(today.slice(5, 7)) - 1;
  const quarterStart = month - (month % 3);
  // The current quarter ends after today; its predecessors end before it.
  for (let back = 0; ; back += 1) {
    const period = new Date(Date.UTC(Number(today.slice(0, 4)), quarterStart - back * 3, 0)).toISOString().slice(0, 10);
    const due = thirteenFDueDate(period);
    if (due < today) return { period, due };
  }
}

/**
 * What a fund whose latest report is `latestPeriod` filed for the newest
 * quarter past its deadline, or null when that report is not behind it.
 * `status` is EDGAR's list of the fund's filings, null when it could not be
 * read. The latest filing for the quarter decides: a 13F-NT, or a report the
 * loaded filings do not have yet.
 */
export function filingGapFor(
  latestPeriod: string | null | undefined,
  status: ThirteenFFilerStatus | null,
  now = new Date(),
): ThirteenFFilingGap | null {
  const { period, due } = newestDueQuarter(now);
  if (!latestPeriod || latestPeriod >= period) return null;
  const filing = status?.filings
    .filter((entry) => entry.period === period)
    .sort((left, right) => right.filed.localeCompare(left.filed) || right.accession.localeCompare(left.accession))[0] ?? null;
  return { period, due, filing, checked: status != null };
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

function quarterIndex(period: string): number | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(period) ?? /^(\d{4})Q([1-4])$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const part = Number(match[2]);
  return year * 4 + (period.includes("Q") ? part - 1 : Math.floor((part - 1) / 3));
}

/**
 * How many quarters a fund's latest report period trails the latest quarter
 * filers have had time to report (`latestLikely13FQuarter`); 0 when it is
 * current or ahead, null without a readable period.
 */
export function quartersBehindLatest(period: string | null | undefined, now = new Date()): number | null {
  const latest = quarterIndex(latestLikely13FQuarter(now));
  const own = period ? quarterIndex(period) : null;
  return latest == null || own == null ? null : Math.max(0, latest - own);
}

/**
 * The fund search lists a manager once for each name it has filed under
 * ("PERSHING SQUARE HOLDCO, L.P." and "PERSHING SQUARE INC." share a CIK).
 * One row per CIK: a renamed manager takes the name on its latest loaded
 * filing, else the longest of its names.
 */
export function oneFundPerCik(
  funds: readonly ThirteenFFund[],
  reports?: ReadonlyMap<string, ThirteenFPeriodReport>,
): ThirteenFFund[] {
  const byCik = new Map<string, ThirteenFFund[]>();
  for (const fund of funds) byCik.set(fund.cik, [...(byCik.get(fund.cik) ?? []), fund]);
  return [...byCik.values()].map((names) => {
    if (names.length === 1) return names[0]!;
    const filed = reports?.get(names[0]!.cik)?.filings.at(-1)?.companyName;
    const longest = names.reduce((best, fund) => (fund.name.length > best.name.length ? fund : best));
    return { ...longest, name: filed || longest.name };
  });
}

export function buildBrowserRows(options: {
  funds?: ThirteenFFund[];
  topFunds?: ThirteenFTopFund[];
  forms?: Map<string, ThirteenFFormSummary>;
  reports?: Map<string, ThirteenFPeriodReport>;
  latestFilings?: ThirteenFFormSummary[];
  source: FundBrowserRow["source"];
}): FundBrowserRow[] {
  if (options.latestFilings) {
    return dedupeLatestForms(options.latestFilings).map((form) => {
      const report = options.reports?.get(form.cik);
      return {
        id: `${options.source}:${form.cik}`,
        cik: form.cik,
        name: form.companyName || form.cik,
        periodOfReport: form.periodOfReport,
        filedAsOfDate: form.filedAsOfDate,
        tableValueTotal: browserReportTotal(form, report, "tableValueTotal"),
        tableEntryTotal: browserReportTotal(form, report, "tableEntryTotal"),
        source: options.source,
      };
    });
  }

  const topByCik = new Map((options.topFunds ?? []).map((fund) => [fund.cik, fund]));
  const funds = options.funds ?? options.topFunds ?? [];
  return funds.map((fund) => {
    const topFund = topByCik.get(fund.cik);
    const report = options.reports?.get(fund.cik);
    const latestForm = report?.filings.at(-1) ?? options.forms?.get(fund.cik);
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
      tableValueTotal: browserReportTotal(form, report, "tableValueTotal"),
      tableEntryTotal: browserReportTotal(form, report, "tableEntryTotal"),
      estQuarterReturn: topFund && topFund.periodOfReport === periodOfReport ? topFund.pnl : null,
      source: options.source,
    };
  });
}

export type ThirteenFAmendmentKind = "restatement" | "new-holdings" | "unknown";

/** How a 13F-HR/A combines with its period's report; null for an original filing. */
export function amendmentKind(form: Pick<ThirteenFFormSummary, "isAmendment" | "amendmentType">): ThirteenFAmendmentKind | null {
  if (!form.isAmendment) return null;
  const type = form.amendmentType?.trim().toUpperCase();
  return type === "RESTATEMENT" ? "restatement" : type === "NEW HOLDINGS" ? "new-holdings" : "unknown";
}

function browserReportTotal(
  form: ThirteenFFormSummary | undefined,
  report: ThirteenFPeriodReport | undefined,
  key: "tableValueTotal" | "tableEntryTotal",
): number | null | undefined {
  if (!form) return undefined;
  if (report?.periodOfReport === form.periodOfReport) return report.complete ? report[key] : null;
  const kind = amendmentKind(form);
  return kind == null || kind === "restatement" ? form[key] : null;
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
    const kind = amendmentKind(form);
    if (kind == null || kind === "restatement") {
      report = { periodOfReport: form.periodOfReport, filings: [form], complete: true,
        tableValueTotal: form.tableValueTotal, tableEntryTotal: form.tableEntryTotal };
    } else if (kind === "new-holdings") {
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

/** The figures of one line of a fund's two filings that its Est P&L reads. */
interface HoldingLine {
  id: string;
  putCall: string;
  value: number | null;
  shares: number | null;
  previousValue: number | null;
  previousShares: number | null;
}

/**
 * Each line's split factor by row id, new shares per old: 1 when its corporate
 * actions show no split between the filings, null when they could not be read.
 */
export type SplitFactors = ReadonlyMap<string, number | null>;

/**
 * The Est P&L of a line held through the quarter, and the value of the shares
 * it is earned on at the quarter's start. `ratio` is the new shares per old of
 * a split between the filings (1 for none): the start is then priced on
 * split-adjusted shares. Null for a line with nothing to price.
 */
function priceHolding(line: HoldingLine, ratio = 1): { pnl: number; base: number } | null {
  // A 13F option value is underlying notional. Its change cannot price the
  // option, and the filing does not identify strike, expiry or premium.
  if (line.putCall.trim()) return null;
  const { value, shares, previousValue, previousShares } = line;
  if (value == null || previousValue == null || value <= 0 || previousValue <= 0) return null;
  if (shares == null || previousShares == null || shares <= 0 || previousShares <= 0) return null;
  const startPrice = previousValue / (previousShares * ratio);
  const held = Math.min(shares, previousShares * ratio);
  return { pnl: (value / shares - startPrice) * held, base: startPrice * held };
}

type HoldingEstimate =
  | { kind: "none" }
  | { kind: "unread" }
  | { kind: "priced"; pnl: number; base: number; ratio: number };

/**
 * The one rule for a line's Est P&L, behind the Holdings column and a fund's
 * quarter estimate alike. A filing prices a line only as value over shares, so
 * a split between the filings reads as a crash (a reverse split as a surge).
 * A line that moves like a split is priced by its factor in `splits`: split-
 * adjusted shares for a split, as it is for 1 (a trade or rebalance), and not
 * at all (`unread`) when its factor is null or absent: never as the crash.
 * `none`: new, exited, an option, or a figure missing.
 */
function estimateHolding(line: HoldingLine, splits?: SplitFactors): HoldingEstimate {
  const plain = priceHolding(line);
  if (!plain) return { kind: "none" };
  if (!movesLikeSplit(line)) return { kind: "priced", ...plain, ratio: 1 };
  const factor = splits?.get(line.id);
  if (factor == null || !(factor > 0)) return { kind: "unread" };
  return { kind: "priced", ...priceHolding(line, factor)!, ratio: factor };
}

/** A line of a fund's two filings: its ticker, else its issuer. */
export interface FilingLine {
  ticker: string;
  issuer: string;
}

/** A fund's return over its latest quarter estimated from its own two filings. */
export interface FilingQuarterReturn {
  /** Percent, as the performance ranking states one; null without a comparable prior quarter or a position held through it. */
  percent: number | null;
  /** Lines split between the filings, priced on split-adjusted shares, with the new shares per old (10 for 10:1, 0.1 for 1:10). */
  splits: Array<FilingLine & { ratio: number }>;
  /** Lines that moved as across a split whose corporate actions could not be read, left out. */
  skipped: FilingLine[];
}

/** The least change in a line's share count that reads as a split: 3:2. */
const SPLIT_MIN_SHARE_RATIO = 1.5;
/** The least move in its value per share the other way: a 3:2 split still reads as one after a quarter up 25%. */
const SPLIT_MIN_PRICE_RATIO = 1.2;

/**
 * Whether a line's shares and value per share moved inversely by about the
 * same ratio between the filings, as across a split: shares up 10x and the
 * value per share down to about a tenth, or a reverse split the other way,
 * the value per share still free to halve or double over the quarter. A
 * position rebalanced to the same dollars after its price doubled or halved
 * moves the same way, so only the line's corporate actions tell the two apart.
 */
function movesLikeSplit(row: HoldingLine): boolean {
  if (!row.previousValue || !row.previousShares || !row.shares || !row.value) return false;
  const shareRatio = row.shares / row.previousShares;
  const startOverEndPrice = (row.previousValue / row.previousShares) / (row.value / row.shares);
  const forward = shareRatio >= SPLIT_MIN_SHARE_RATIO && startOverEndPrice >= SPLIT_MIN_PRICE_RATIO;
  const reverse = shareRatio <= 1 / SPLIT_MIN_SHARE_RATIO && startOverEndPrice <= 1 / SPLIT_MIN_PRICE_RATIO;
  return (forward || reverse) && Math.abs(Math.log(shareRatio) - Math.log(startOverEndPrice)) <= Math.LN2;
}

/** `10:1`, `3:2`, `1:10`: a split ratio of new shares per old. */
export function formatSplitRatio(ratio: number): string {
  const up = ratio >= 1 ? ratio : 1 / ratio;
  const old = [1, 2, 3, 4, 5, 10].find((shares) => Math.abs(up * shares - Math.round(up * shares)) < 1e-6);
  const [next, per] = old ? [Math.round(up * old), old] : [Number(up.toFixed(2)), 1];
  return ratio >= 1 ? `${next}:${per}` : `${per}:${next}`;
}

/**
 * The lines of a fund's two filings whose shares and value per share moved
 * as across a split (movesLikeSplit), by row id, for their corporate actions
 * to say whether one happened: the lines estimateHolding leaves unread when
 * no factor is known.
 */
export function filingSplitCandidates(data: FundDetailData): Array<FilingLine & { id: string }> {
  return buildFundHoldingRows(data).filter((row) => row.splitUnread).map((row) => ({ id: row.id, ticker: row.ticker, issuer: row.issuer }));
}

/**
 * A fund's estimated return over its latest quarter from its own two filings,
 * in percent as the performance ranking states one: the Est P&L of the share
 * positions held at both quarter ends (the Holdings view's column) over what
 * those shares were worth at the start of the quarter. Options are left out,
 * as Est P&L leaves them out.
 *
 * Each line is priced by estimateHolding, the rule the Holdings column uses,
 * so the two cannot disagree. `splits` holds, for each of
 * filingSplitCandidates, the split factor its corporate actions show between
 * the two quarter ends: a split's start is priced on split-adjusted shares,
 * and a line with none (1) is a trade, priced as it is. A candidate without
 * one (null or absent: its actions could not be read) is left out, rather than
 * read as a crash or a split it may not be.
 */
export function estimateFilingQuarterReturn(data: FundDetailData, splits: SplitFactors = new Map()): FilingQuarterReturn {
  const adjusted: FilingQuarterReturn["splits"] = [];
  const skipped: FilingLine[] = [];
  if (!hasComparable13FQuarter(data)) return { percent: null, splits: adjusted, skipped };
  let pnl = 0;
  let base = 0;
  for (const row of buildFundHoldingRows(data)) {
    const estimate = estimateHolding(row, splits);
    const line = { ticker: row.ticker, issuer: row.issuer };
    if (estimate.kind === "unread") skipped.push(line);
    if (estimate.kind !== "priced") continue;
    if (estimate.ratio !== 1) adjusted.push({ ...line, ratio: estimate.ratio });
    pnl += estimate.pnl;
    base += estimate.base;
  }
  return { percent: base > 0 ? (pnl / base) * 100 : null, splits: adjusted, skipped };
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

/**
 * A fund's holdings with their change from the prior quarter. `splits` says,
 * for the lines that moved as across a split (filingSplitCandidates), whether
 * a split happened between the filings (estimateHolding); without a factor
 * such a line has no Est P&L (`splitUnread`).
 */
export function buildFundHoldingRows(data: FundDetailData | null, splits?: SplitFactors): FundHoldingRow[] {
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
    const estimate = estimateHolding({ id, putCall: display.putCall, value, shares, previousValue, previousShares }, splits);
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
      estimatedPnl: estimate.kind === "priced" ? estimate.pnl : null,
      ...(estimate.kind === "priced" && estimate.ratio !== 1 ? { splitRatio: estimate.ratio } : {}),
      ...(estimate.kind === "unread" ? { splitUnread: true } : {}),
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
    case "return1": return row.priorReturns?.[0]?.value ?? null;
    case "return2": return row.priorReturns?.[1]?.value ?? null;
    case "return3": return row.priorReturns?.[2]?.value ?? null;
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
    case "mine": return row.mine ? 1 : 0;
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

/** The name column takes the room the figures leave; the table lays it out. */
export function buildBrowserColumns(withEstimate = true): FundBrowserColumn[] {
  const cikWidth = 12;
  const periodWidth = 10;
  const filedWidth = 9;
  const valueWidth = 11;
  const rowsWidth = 6;
  const retWidth = withEstimate ? 9 : 0;
  return [
    { id: "fund", label: "FUND", width: 18, align: "left", flexGrow: 1 },
    { id: "cik", label: "CIK", width: cikWidth, align: "left" },
    { id: "period", label: "PERIOD", width: periodWidth, align: "left" },
    ...(retWidth > 0 ? [{ id: "estQuarterReturn" as const, label: "EST 13F", width: retWidth, align: "right" as const }] : []),
    { id: "value", label: "VALUE", width: valueWidth, align: "right" },
    { id: "rows", label: "ROWS", width: rowsWidth, align: "right" },
    { id: "filed", label: "FILED", width: filedWidth, align: "left" },
  ];
}

export function buildFilingPositionColumns(): FilingPositionColumn[] {
  const tickerWidth = 9;
  const typeWidth = 8;
  const valueWidth = 12;
  const weightWidth = 8;
  const sharesWidth = 11;
  const cusipWidth = 10;
  const discretionWidth = 8;
  return [
    { id: "ticker", label: "TICKER", width: tickerWidth, align: "left" },
    { id: "type", label: "TYPE", width: typeWidth, align: "left" },
    { id: "issuer", label: "ISSUER", width: 16, align: "left", flexGrow: 1 },
    { id: "value", label: "VALUE", width: valueWidth, align: "right" },
    { id: "weight", label: "13F %", width: weightWidth, align: "right" },
    { id: "shares", label: "SHARES", width: sharesWidth, align: "right" },
    { id: "cusip", label: "CUSIP", width: cusipWidth, align: "left" },
    { id: "discretion", label: "DISCR", width: discretionWidth, align: "left" },
  ];
}

export function buildHoldingColumns(): FundHoldingColumn[] {
  const tickerWidth = 9;
  const typeWidth = 8;
  const valueWidth = 12;
  const pnlWidth = 12;
  const weightWidth = 8;
  const sharesWidth = 11;
  const changeWidth = 11;
  const actionWidth = 7;
  return [
    { id: "ticker", label: "TICKER", width: tickerWidth, align: "left" },
    { id: "type", label: "TYPE", width: typeWidth, align: "left" },
    { id: "issuer", label: "ISSUER", width: 18, align: "left", flexGrow: 1 },
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
