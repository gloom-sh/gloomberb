import type { FinancialStatement, StatementPeriodFiling, TickerFinancials } from "../../../../types/financials";
import { ebitdaLacksDepreciation } from "../../../../utils/ebitda";
import { safeExternalUrl } from "../../../../utils/external-url";
import { longerPeriodLabel, statementPeriodLabel, ttmPeriodLabel } from "../../../../utils/fiscal-period";
import { areNearbyFinancialPeriodEnds, fillDate, fillDateText, statementPeriodMonths } from "../../../../utils/financial-statements";
import { formatPerShareNumber } from "../../../../utils/reported-money";
import { hasNonIncomeStatementGap } from "../../../../utils/statement-gaps";
import { growthRate, isNotMeaningful, NOT_MEANINGFUL_TEXT, outflowGrowthRate, type Rate } from "../../../../utils/growth";
import {
  MISSING_VALUE,
  displayWidth,
  formatGrowthShort,
  formatNumber,
  padTo,
  pickUnit,
} from "../../../../utils/format";
import {
  buildPreviousStatementMap,
  computeTTM,
  servedTrailingStatement,
  type FinancialPeriod,
  type FinancialTableStatement,
} from "./aggregation";
import { FINANCIAL_SUB_TABS } from "./schema";

export { computeTTM } from "./aggregation";
export { FINANCIAL_SUB_TABS } from "./schema";
export type { FinancialPeriod } from "./aggregation";

/** A ticker with statements to show: what the Financials view needs, and what Overview's way into it asks for. */
export function hasStatementFinancials(financials: TickerFinancials | null | undefined): boolean {
  return (financials?.annualStatements.length ?? 0) > 0 || (financials?.quarterlyStatements.length ?? 0) > 0;
}

type FinancialMetricFormat = "compact" | "eps" | "percent";
export type FinancialGrowthDirection = "higher" | "lower" | "neutral";

type MetricDef = {
  label: string;
  key?: keyof FinancialStatement;
  id?: string;
  /** A figure worked out of the statement: a margin, N/M over revenue that is zero or negative (revenueMargin). */
  compute?: (statement: FinancialStatement) => Rate | undefined;
  format: FinancialMetricFormat;
  showGrowth?: boolean;
  growthDirection?: FinancialGrowthDirection;
  /** A line kept as a negative number (capex, dividends paid): its growth is the change in what went out. */
  outflow?: boolean;
};

export type FinancialRowDef = MetricDef | FinancialGroupDef;

type FinancialGroupDef = {
  kind: "group";
  id: string;
  label: string;
  summaryKey?: keyof FinancialStatement;
  format?: FinancialMetricFormat;
  growthDirection?: FinancialGrowthDirection;
  defaultExpanded?: boolean;
  children: FinancialRowDef[];
};

export type FinancialSubTab = {
  name: string;
  key: string;
  rows: FinancialRowDef[];
};

export type FinancialTableRow =
  | {
    kind: "metric";
    id: string;
    key?: keyof FinancialStatement;
    compute?: (statement: FinancialStatement) => Rate | undefined;
    label: string;
    unitLabel: string;
    /** Money unit word (`bn`) the values are in, "" for whole units; null for ratios, per-share values and share counts. */
    moneyUnit: string | null;
    divisor: number;
    format: FinancialMetricFormat;
    showGrowth: boolean;
    growthDirection: FinancialGrowthDirection;
    outflow?: boolean;
    depth: number;
  }
  | {
    kind: "group";
    id: string;
    label: string;
    unitLabel: string;
    moneyUnit: string | null;
    summaryKey?: keyof FinancialStatement;
    divisor: number;
    format: FinancialMetricFormat;
    growthDirection: FinancialGrowthDirection;
    depth: number;
    expanded: boolean;
    toggleable: boolean;
  };

function statementMetricValue(
  def: Pick<MetricDef, "key" | "compute">,
  statement: FinancialStatement,
): number | undefined {
  const value = def.key ? statement[def.key] : def.compute?.(statement);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The figure a row shows for a period: a group's summary line, or the row's own. */
function financialCellValue(row: FinancialTableRow, statement: FinancialStatement): number | undefined {
  if (row.kind === "group") return row.summaryKey ? statement[row.summaryKey] as number | undefined : undefined;
  return statementMetricValue(row, statement);
}

/** Whether a worked-out figure (a margin) is not meaningful in a statement: over revenue that is zero or negative. */
function statementMetricNotMeaningful(
  def: Pick<MetricDef, "key" | "compute">,
  statement: FinancialStatement,
): boolean {
  return !def.key && isNotMeaningful(def.compute?.(statement));
}

export const FINANCIAL_COL_W = 18;
export const FINANCIAL_LABEL_W = 28;
const FINANCIAL_LABEL_MIN_W = 12;
/** The narrowest metric column that shows a statement's line names whole in the terminal, indent and all (`    Other Income/Exp`). */
const FINANCIAL_LABEL_WHOLE_W = 20;
/** The same on the desktop and the web, which draw a name against the column's edge. */
const FINANCIAL_LABEL_WHOLE_FLUSH_W = 18;
/** The narrowest metric column a second period is worth on a phone: the longest names lose a letter or two to an ellipsis. */
const FINANCIAL_LABEL_PAIR_W = 14;

/**
 * The metric column's width in a table `width` cells wide with `periods`
 * period columns `periodWidth` wide. It gives the room to whole periods, not
 * to part of one: as many as fit beside names still read in full, then the
 * names take what is left, up to 28. `flush` is the desktop and the web,
 * where a name starts at the column's edge and so needs fewer cells; there a
 * phone, which would show one period that way, lets its longest names lose a
 * letter for a second, since a figure says little without the one it grew
 * from. Narrower still, the column shrinks to 12 before it takes every value
 * off screen, as a 36-column Financials pane once showed nothing but metric
 * names and "more →". The other 5 cells are the pane's padding, the table's
 * and the scrollbar; each period takes one more, the gap before it.
 */
export function financialLabelWidth(width: number, periodWidth = FINANCIAL_COL_W, periods = 1, flush = false): number {
  const room = width - 5;
  const pitch = periodWidth + 1;
  const fit = (labelWidth: number) => Math.min(Math.max(1, periods), Math.floor((room - labelWidth) / pitch));
  const whole = Math.max(
    fit(flush ? FINANCIAL_LABEL_WHOLE_FLUSH_W : FINANCIAL_LABEL_WHOLE_W),
    flush ? Math.min(2, fit(FINANCIAL_LABEL_PAIR_W)) : 0,
  );
  if (whole >= 1) return Math.min(FINANCIAL_LABEL_W, room - whole * pitch);
  return Math.max(FINANCIAL_LABEL_MIN_W, Math.min(FINANCIAL_LABEL_W, room - pitch));
}
/** The growth after a period's value: a blank and up to six characters (`+466%`, `<-99T%`). */
const FINANCIAL_GROWTH_W = 7;

/** The cells a table keeps after a header's label for its sort mark (`tableColumnWidth`). */
const FINANCIAL_HEADER_RESERVE_W = 2;

/**
 * A period column as wide as the widest value it shows and the growth after
 * it, or its header with the cells the table keeps after one, or the day it
 * ends (`ends`, the table's first row), whichever is widest. A fixed 18 left a
 * short value further from its own column's edge than from its growth, so
 * each pair read tight and the next period far off, and fewer periods fit.
 */
export function financialPeriodWidth(values: Iterable<string>, headers: Iterable<string>, ends: Iterable<string> = []): number {
  let value = 0;
  for (const text of values) value = Math.max(value, displayWidth(text));
  let header = 0;
  for (const text of headers) header = Math.max(header, displayWidth(text) + FINANCIAL_HEADER_RESERVE_W);
  let end = 0;
  // The day is drawn in the cells the header has.
  for (const text of ends) end = Math.max(end, text ? displayWidth(text) + FINANCIAL_HEADER_RESERVE_W : 0);
  return Math.max(value + FINANCIAL_GROWTH_W, header, end);
}

/**
 * A period's header, or the day it ends, centred in the cells a column
 * `periodWidth` wide has for its header: the column less the two the table
 * keeps after a label. The header and the day under it share those cells, so
 * one sits centred over the other.
 */
export function financialPeriodHeaderLabel(text: string, periodWidth: number): string {
  return padTo(text, Math.max(displayWidth(text), periodWidth - FINANCIAL_HEADER_RESERVE_W), "center");
}

/**
 * A line's growth from one period to the next: N/M off a zero or negative base (a loss
 * narrowing, or turning into a profit, is no percentage of the loss). An outflow, kept as a
 * negative number, grows as the money that went out does.
 */
export function computeGrowth(current: number | undefined, previous: number | undefined, outflow = false): Rate | undefined {
  return outflow ? outflowGrowthRate(current, previous) : growthRate(current, previous);
}

/**
 * A row's cell in a statement column: its figure as shown (N/M for a margin over revenue
 * that is zero or negative) and its growth on the period it is compared with.
 */
export function financialCellParts(
  row: FinancialTableRow,
  statement: FinancialTableStatement,
  previous: FinancialStatement | undefined,
  comparisonCurrency: string | undefined,
): { value: number | undefined; formattedValue: string; growth: Rate | undefined } {
  const value = financialCellValue(row, statement);
  const previousValue = previous ? financialCellValue(row, previous) : undefined;
  const growth = (row.kind === "metric" && !row.showGrowth)
    || !canCompareFinancialRow(row, statement, previous, comparisonCurrency)
    ? undefined : computeGrowth(value, previousValue, row.kind === "metric" && row.outflow === true);
  return { value, formattedValue: formatFinancialCellValue(row, statement), growth };
}

/** A row's figure for a period as its cell shows it: N/M for a margin over revenue that is zero or negative. */
export function formatFinancialCellValue(row: FinancialTableRow, statement: FinancialStatement): string {
  return row.kind === "metric" && statementMetricNotMeaningful(row, statement)
    ? NOT_MEANINGFUL_TEXT
    : formatFinancialValue(financialCellValue(row, statement), row, statement);
}

const SHARE_COUNT_FIELDS = new Set<keyof FinancialStatement>([
  "basicShares", "dilutedShares", "shareIssued", "ordinarySharesNumber", "treasurySharesNumber",
]);

const PER_SHARE_EARNINGS_FIELDS = new Set<keyof FinancialStatement>(["eps", "basicEps"]);

/**
 * Currency changes affect monetary comparisons, not counts of reported
 * shares. Counts and EPS compare only on one share basis: receipts against
 * ordinary shares would read as a split.
 */
function canCompareFinancialRow(
  row: FinancialTableRow,
  current: FinancialStatement,
  previous: FinancialStatement | undefined,
  financialCurrency?: string,
): boolean {
  if (!previous) return false;
  const key = row.kind === "group" ? row.summaryKey : row.key;
  // A line filled from the exchange is not compared with the statements source's: the two may define it
  // differently. A results announcement that restates the source's figure for the year before is the same line.
  if (key && filledLine(current, key) !== filledLine(previous, key) && !comparableLine(current, previous, key)) return false;
  const sameShareBasis = current.shareBasis === previous.shareBasis;
  if (key && SHARE_COUNT_FIELDS.has(key)) return sameShareBasis;
  if (key && PER_SHARE_EARNINGS_FIELDS.has(key) && !sameShareBasis) return false;
  const currentCurrency = (current.currency ?? financialCurrency)?.trim();
  const previousCurrency = (previous.currency ?? financialCurrency)?.trim();
  return !!currentCurrency && currentCurrency === previousCurrency;
}

function filledLine(statement: FinancialStatement, key: keyof FinancialStatement): boolean {
  return statement.filledFrom?.fields.some((field) => field === key) === true;
}

/**
 * A filled year's line compared with the source's a year earlier: the lines
 * Gloom Cloud found on the source's basis (`comparable`), or, from a server
 * that does not say, every line of a year a year apart, so a filled year
 * always has its year-on-year change.
 */
function comparableLine(current: FinancialStatement, previous: FinancialStatement, key: keyof FinancialStatement): boolean {
  const fill = current.filledFrom;
  if (fill?.source !== "results" || filledLine(previous, key)) return false;
  if (fill.definitions?.some(({ field }) => field === key)) return false;
  if (fill.comparable) return fill.comparable.some((field) => field === key);
  const days = (Date.parse(current.date) - Date.parse(previous.date)) / 86_400_000;
  return !fill.periodMonths && days >= 300 && days <= 430;
}

export function semanticGrowthValue(
  growth: Rate | undefined,
  direction: FinancialGrowthDirection,
): number | undefined {
  if (growth == null || isNotMeaningful(growth)) return undefined;
  if (direction === "lower") return -growth;
  if (direction === "neutral") return 0;
  return growth;
}

/** A period's value and its growth laid out in a column `width` cells wide, the growth against its right edge. */
export function formatFinancialCell(value: string, growth: Rate | undefined, width = FINANCIAL_COL_W) {
  const growthText = isNotMeaningful(growth) ? NOT_MEANINGFUL_TEXT
    : growth != null && Number.isFinite(growth) ? formatFinancialGrowth(growth) : "";
  return {
    valueText: padTo(value, Math.max(0, width - FINANCIAL_GROWTH_W), "right"),
    growthText: padTo(growthText ? ` ${growthText}` : "", FINANCIAL_GROWTH_W, "right"),
  };
}

function formatFinancialGrowth(growth: number): string {
  const plain = formatGrowthShort(growth);
  const budget = FINANCIAL_GROWTH_W - 1;
  if (plain.length <= budget) return plain;
  const percent = growth * 100;
  if (!Number.isFinite(percent)) return growth < 0 ? "<-99T%" : ">99T%";
  const sign = percent < 0 ? "-" : "+";
  const magnitude = Math.abs(percent);
  for (const [scale, suffix] of [[1e3, "k"], [1e6, "M"], [1e9, "B"], [1e12, "T"]] as const) {
    if (magnitude < scale) continue;
    const scaled = magnitude / scale;
    const digits = scaled < 10 ? 1 : 0;
    const compact = `${sign}${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}%`;
    if (compact.length <= budget) return compact;
  }
  const exponential = `${sign}${magnitude.toExponential(0).replace("e+", "e")}%`;
  return exponential.length <= budget ? exponential : percent < 0 ? "<-99T%" : ">99T%";
}

function formatFinancialValue(
  value: number | undefined,
  row: Pick<FinancialTableRow, "format" | "divisor"> & { key?: string },
  statement?: FinancialStatement,
): string {
  // EBITDA is operating income plus D&A: a period that reports no D&A has none, and its cell says why.
  if ((value == null || !Number.isFinite(value)) && row.key === "ebitda" && ebitdaLacksDepreciation(statement)) return "no D&A";
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  if (row.format === "eps") return formatPerShareNumber(value);
  if (row.format === "percent") return `${formatNumber(value * 100, 1)}%`;
  return formatFinancialAmount(value, row.divisor);
}

/**
 * An amount in the table's one unit, to about three significant figures: `23.73` and `1,265.6`, a line a
 * thousandth of the others as `0.001` rather than `0.00`, so no row needs a unit of its own.
 */
export function formatFinancialAmount(value: number, divisor: number): string {
  const scaled = value / divisor;
  const magnitude = Math.abs(scaled);
  if (magnitude >= 100) return formatNumber(scaled, 1);
  if (magnitude >= 1 || scaled === 0) return scaled.toFixed(2);
  if (magnitude >= 0.001) return scaled.toFixed(3);
  return Number(scaled.toPrecision(2)).toString();
}

/**
 * A report column's header (`gloom fn FA`): the fiscal period as the pane's
 * column names it and the day it ends (`FY2026 2026-09-30 USD bn (SEC
 * date)`, `TTM Q3 FY26 2026-09-30 USD`), with a half in the quarterly list
 * named as one (`H1 FY26 2026-06-30`, or `6M 2026-06-30` off the fiscal
 * calendar), and a column Gloom Cloud filled
 * from the company's results announcements dated by them alone (fillDate):
 * `(announced 2026-08-20)` for its own results, `(comparative in the
 * 2026-08-20 announcement)` for a later period's comparative column. `rows`
 * are the list's other rows, where the later period's announcement is read.
 */
export function financialReportHeader(
  statement: FinancialTableStatement,
  currency: string | undefined,
  kind: FinancialPeriod,
  yearEndMonth: number | null,
  rows: readonly FinancialStatement[] = [],
): string {
  const period = financialFiscalHeader(statement, kind, yearEndMonth);
  const header = currency ? `${period} ${currency}` : period;
  if (statement.date === "TTM") return header;
  const filled = statement.filledFrom?.source === "results" ? fillDate(statement, rows) : null;
  const source = filled ? fillDateText(filled) : statement.dateSource === "sec" ? "SEC date" : "provider date";
  return `${header} (${source})`;
}

/**
 * The fiscal period, with a half in the quarterly list named as a half
 * (`H1 FY26`), and `TTM` with the quarter or half it runs to.
 */
export function financialColumnLabel(
  statement: FinancialTableStatement,
  kind: FinancialPeriod,
  yearEndMonth: number | null,
): string {
  if (statement.date !== "TTM") return statementPeriodLabel(statement, kind, yearEndMonth);
  const { periodEnd, interimMonths } = statement.aggregation ?? {};
  return ttmPeriodLabel(periodEnd, yearEndMonth, interimMonths);
}

/** The day a column's period ends: a statement's own date, a TTM's last quarter or half. */
export function financialPeriodEnd(statement: FinancialTableStatement): string | undefined {
  return statement.date === "TTM" ? statement.aggregation?.periodEnd : statement.date.slice(0, 10);
}

/** A column's fiscal period as its own header names it, the day it ends aside: a half in the quarterly list as `H1 FY26`, or `6M` off the fiscal calendar. */
function financialPeriodName(statement: FinancialTableStatement, kind: FinancialPeriod, yearEndMonth: number | null): string {
  const end = financialPeriodEnd(statement);
  const months = kind === "quarterly" && statement.date !== "TTM" ? statementPeriodMonths(statement) : undefined;
  const longer = end && months && months > 3 ? longerPeriodLabel(end, months, yearEndMonth) : null;
  return longer ?? financialColumnLabel(statement, kind, yearEndMonth);
}

/**
 * The pane's column header: the fiscal period alone (`TTM Q2 FY27`, `FY2026`,
 * `H1 FY26`, `6M`). The day it ends is the table's first row (`Period end`),
 * so a column is as wide as its figures, not as its date, and more periods
 * show side by side.
 */
export function financialColumnName(statement: FinancialTableStatement, kind: FinancialPeriod, yearEndMonth: number | null): string {
  const name = financialPeriodName(statement, kind, yearEndMonth);
  const end = financialPeriodEnd(statement);
  return end && name.endsWith(` ${end}`) ? name.slice(0, -end.length - 1) : name;
}

function financialFiscalHeader(statement: FinancialTableStatement, kind: FinancialPeriod, yearEndMonth: number | null): string {
  const end = financialPeriodEnd(statement);
  const name = financialPeriodName(statement, kind, yearEndMonth);
  return end && !name.endsWith(end) ? `${name} ${end}` : name;
}

/** An annual balance sheet can lead with a newer interim position. */
export function financialColumnPeriod(statement: FinancialTableStatement, period: FinancialPeriod, annualDates: ReadonlySet<string>): FinancialPeriod {
  return period === "annual" && (statement.date === "TTM" || annualDates.has(statement.date)) ? "annual" : "quarterly";
}

/** An issuer's report for the displayed period, even when the figures come from a provider. */
export function financialPeriodFiling(
  filings: readonly StatementPeriodFiling[] | undefined,
  statement: FinancialTableStatement,
  period: FinancialPeriod,
): StatementPeriodFiling | undefined {
  if (statement.date === "TTM") return undefined;
  const end = financialPeriodEnd(statement);
  return filings?.find((filing) => filing.periodEnd === end
    && (filing.periodMonths === 12) === (period === "annual") && !!safeExternalUrl(filing.url));
}

export function latestFinancialPeriodEnd(statements: readonly FinancialTableStatement[]): string | undefined {
  return statements
    .map(financialPeriodEnd)
    .reduce<string | undefined>((max, end) => (end && (!max || end > max) ? end : max), undefined);
}

export function financialGrowthNotice(period: FinancialPeriod, statements: readonly FinancialStatement[]): string {
  if (period === "annual") return "Growth: YoY.";
  return statements.some((statement) => statement.date !== "TTM" && (statementPeriodMonths(statement) ?? 3) > 3)
    ? "Growth: QoQ; half-year growth is YoY."
    : "Growth: QoQ.";
}

export function financialStatementDateNotice(statements: readonly FinancialStatement[]): string {
  const dated = statements.filter(({ date }) => date !== "TTM");
  return [
    dated.some(({ dateSource }) => dateSource !== "sec") ? "P: provider period date; may be approximate." : "",
    dated.some(({ dateSource }) => dateSource === "sec") ? "S: SEC fiscal date; filing evidence identifies the period, not every metric's publication date." : "",
  ].filter(Boolean).join(" ");
}

export function financialStatementCurrency(
  financials: Pick<TickerFinancials, "financialCurrency" | "fundamentals"> | null | undefined,
  statements: readonly FinancialStatement[],
): string | undefined {
  const fallback = financials?.financialCurrency;
  const currencies = new Set(statements.map((statement) => statement.currency ?? fallback));
  return currencies.size === 1 ? [...currencies][0] : undefined;
}

export function financialStatementLimitations(financials: TickerFinancials | null | undefined): string[] {
  const limitations: string[] = [];
  if ([...(financials?.annualStatements ?? []), ...(financials?.quarterlyStatements ?? [])].some(hasNonIncomeStatementGap)) {
    limitations.push("Some statement values conflict with issuer filings and are unavailable.");
  }
  if ([...(financials?.annualStatements ?? []), ...(financials?.quarterlyStatements ?? [])].some(row => row.unavailableFields?.includes("netIncome"))) {
    limitations.push("Parent net income is unavailable for some reported periods.");
  }
  return limitations;
}

/**
 * What a scoped statement series is filed as, such as a spun-off listing's history in its predecessor's consolidated
 * accounts, and a newer filing still under review for it. It is said in full above the table, where no pane width
 * cuts it, so the figures are never read as the listing's own; the CSV says it as its "Statement basis". Null for
 * statements with no scope, which are the listing's own.
 */
export function financialStatementBasisNote(
  financials: Pick<TickerFinancials, "statementScope" | "statementReview"> | null | undefined,
): string | null {
  const scope = financials?.statementScope;
  if (!scope) return null;
  return `Statement basis: ${scope.label}.${financials.statementReview?.status === "pending" ? " New filing under review." : ""}`;
}

/** "Ordinary Shares (bn ADRs)": a share-count line whose counts are depositary receipts. */
export function receiptShareCountLabel(row: Pick<FinancialTableModelRow, "key" | "label" | "unitLabel">): string {
  if (!row.key || !SHARE_COUNT_FIELDS.has(row.key)) return row.unitLabel;
  const unit = row.unitLabel.startsWith(`${row.label} (`) ? row.unitLabel.slice(row.label.length + 2, -1) : "";
  return `${row.label} (${unit ? `${unit} ` : ""}ADRs)`;
}

/** Whether a table row shows share counts or per-share earnings. */
export function isPerShareFinancialRow(row: Pick<FinancialTableModelRow, "key" | "summaryKey">): boolean {
  const key = row.key ?? row.summaryKey;
  return !!key && (SHARE_COUNT_FIELDS.has(key) || PER_SHARE_EARNINGS_FIELDS.has(key));
}

export function resolveFinancialPeriod(
  requestedPeriod: FinancialPeriod,
  hasAnnualStatements: boolean,
  hasQuarterlyStatements: boolean,
): FinancialPeriod {
  if (requestedPeriod === "annual") {
    return hasAnnualStatements || !hasQuarterlyStatements ? "annual" : "quarterly";
  }
  return hasQuarterlyStatements || !hasAnnualStatements ? "quarterly" : "annual";
}

function isFinancialGroup(row: FinancialRowDef): row is FinancialGroupDef {
  return "kind" in row && row.kind === "group";
}

export function collectGroupIds(rows: FinancialRowDef[]): string[] {
  return rows.flatMap((row) => {
    if (!isFinancialGroup(row)) return [];
    return [row.id, ...collectGroupIds(row.children)];
  });
}

export function collectDefaultCollapsedGroupIds(rows: FinancialRowDef[]): string[] {
  return rows.flatMap((row) => {
    if (!isFinancialGroup(row)) return [];
    return [
      ...(row.defaultExpanded === true ? [] : [row.id]),
      ...collectDefaultCollapsedGroupIds(row.children),
    ];
  });
}

function hasStatementValue(
  statements: FinancialStatement[],
  key: keyof FinancialStatement,
): boolean {
  return statements.some((statement) => typeof statement[key] === "number" && Number.isFinite(statement[key]));
}

function hasFinancialRowValue(
  row: FinancialRowDef,
  statements: FinancialStatement[],
): boolean {
  if (!isFinancialGroup(row)) {
    return statements.some((statement) => typeof statementMetricValue(row, statement) === "number" || statementMetricNotMeaningful(row, statement));
  }
  return (
    (row.summaryKey ? hasStatementValue(statements, row.summaryKey) : false)
    || row.children.some((child) => hasFinancialRowValue(child, statements))
  );
}

function repeatsLine(
  line: Pick<MetricDef, "key" | "compute">,
  other: Pick<MetricDef, "key" | "compute">,
  statements: FinancialStatement[],
): boolean {
  return statements.every((statement) => {
    const value = statementMetricValue(line, statement);
    return value === undefined || value === statementMetricValue(other, statement);
  });
}

/**
 * Companies without minority interests or discontinued operations report the
 * net income headline again on several lines, and statements repeat one
 * amount under several names (D&A and Depreciation, Buybacks and Stock
 * Payments). A line that equals its group's headline, or a line kept above
 * it, in every shown period where it is reported adds nothing.
 */
function distinctChildren(
  group: FinancialGroupDef,
  statements: FinancialStatement[],
): FinancialRowDef[] {
  const summaryKey = group.summaryKey;
  const kept: FinancialRowDef[] = [];
  for (const child of group.children) {
    if (!hasFinancialRowValue(child, statements)) continue;
    if (!isFinancialGroup(child) && child.key !== summaryKey && (
      (summaryKey && repeatsLine(child, { key: summaryKey }, statements))
      || kept.some((line) => !isFinancialGroup(line) && line.format === child.format
        && repeatsLine(child, line, statements))
    )) continue;
    kept.push(child);
  }
  return kept;
}

const UNIT_WORDS: Record<string, string> = { K: "k", M: "mn", B: "bn", T: "tn" };
const UNIT_DIVISORS: Record<string, number> = { k: 1e3, mn: 1e6, bn: 1e9, tn: 1e12 };

function resolveMetricUnit(
  statements: FinancialStatement[],
  def: Pick<MetricDef, "key" | "compute" | "format">,
  label: string,
) {
  const format = def.format ?? "compact";
  const isEps = format === "eps";
  const isPercent = format === "percent";
  const allValues = statements.map((statement) => statementMetricValue(def, statement));
  const { suffix, divisor } = isEps || isPercent ? { suffix: "", divisor: 1 } : pickUnit(allValues);
  const unit = UNIT_WORDS[suffix] ?? suffix;
  return {
    unitLabel: unit ? `${label} (${unit})` : label,
    // Share counts are not money, so they never take the table's money unit.
    moneyUnit: format === "compact" && !(def.key && SHARE_COUNT_FIELDS.has(def.key)) ? unit : null,
    label,
    divisor,
    format,
  };
}

/**
 * The money unit of the whole table (`bn`), said once beside the currency:
 * the unit most rows would take on their own. Every money row is shown in it,
 * a smaller line to more decimals (formatFinancialAmount), so a column copied
 * out of the table is in one unit and no row carries a `(mn)` of its own.
 * Share counts are no money and keep theirs.
 */
export function shareFinancialUnit<T extends { unitLabel: string; label: string; moneyUnit: string | null; divisor: number }>(
  rows: readonly T[],
): { rows: T[]; unit: string | undefined } {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.moneyUnit) counts.set(row.moneyUnit, (counts.get(row.moneyUnit) ?? 0) + 1);
  const unit = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (!unit) return { rows: [...rows], unit: undefined };
  return {
    rows: rows.map((row) => row.moneyUnit == null ? row : { ...row, unitLabel: row.label, moneyUnit: unit, divisor: UNIT_DIVISORS[unit]! }),
    unit,
  };
}

export function buildFinancialRows(
  defs: FinancialRowDef[],
  statements: FinancialStatement[],
  collapsedGroups: ReadonlySet<string>,
  depth = 0,
  /** The lines the table already shows, above this one: a line equal to one of them is left out. */
  shown: Array<Pick<MetricDef, "key" | "compute" | "format">> = [],
): FinancialTableRow[] {
  const rows: FinancialTableRow[] = [];

  for (const def of defs) {
    if (!hasFinancialRowValue(def, statements)) continue;

    if (!isFinancialGroup(def)) {
      // The same amount under another name further down (CapEx, then Purchase PPE) is shown once, where it is
      // reported in every period the line above is; a line that differs in any period stays.
      if (shown.some((line) => line.format === (def.format ?? "compact") && (line.key !== def.key || line.compute !== def.compute)
        && repeatsLine(def, line, statements))) continue;
      shown.push({ key: def.key, compute: def.compute, format: def.format ?? "compact" });
      const { unitLabel, moneyUnit, divisor, format } = resolveMetricUnit(statements, def, def.label);
      rows.push({
        kind: "metric",
        id: `${def.id ?? String(def.key)}:${depth}`,
        key: def.key,
        compute: def.compute,
        label: def.label,
        unitLabel,
        moneyUnit,
        divisor,
        format,
        showGrowth: def.showGrowth ?? format !== "percent",
        // More spent is neither better nor worse in itself.
        growthDirection: def.growthDirection ?? (def.outflow ? "neutral" : "higher"),
        ...(def.outflow ? { outflow: true } : {}),
        depth,
      });
      continue;
    }

    const children = distinctChildren(def, statements);
    const toggleable = children.length > 0;
    const expanded = toggleable && !collapsedGroups.has(def.id);
    const metricUnit = def.summaryKey
      ? resolveMetricUnit(statements, { key: def.summaryKey, format: def.format ?? "compact" }, def.label)
      : { unitLabel: def.label, moneyUnit: null, divisor: 1, format: def.format ?? "compact" };

    if (def.summaryKey) shown.push({ key: def.summaryKey, format: def.format ?? "compact" });
    rows.push({
      kind: "group",
      id: def.id,
      label: def.label,
      unitLabel: metricUnit.unitLabel,
      moneyUnit: metricUnit.moneyUnit,
      summaryKey: def.summaryKey,
      divisor: metricUnit.divisor,
      format: metricUnit.format,
      growthDirection: def.growthDirection ?? "higher",
      depth,
      expanded,
      toggleable,
    });

    if (expanded) {
      rows.push(...buildFinancialRows(children, statements, collapsedGroups, depth + 1, shown));
    }
  }

  return rows;
}

export function resolveFinancialSubTabKey(value: string | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return FINANCIAL_SUB_TABS[0]!.key;
  if (normalized === "cf" || normalized === "cashflows") return "cashflow";
  if (normalized === "bs" || normalized === "balancesheet") return "balance";
  return FINANCIAL_SUB_TABS.find((tab) => (
    tab.key.toLowerCase() === normalized
    || tab.name.toLowerCase().replace(/[\s_-]+/g, "") === normalized
  ))?.key ?? FINANCIAL_SUB_TABS[0]!.key;
}

export function resolveFinancialPeriodOption(value: string | undefined): FinancialPeriod | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (["a", "ann", "annual", "year", "yearly", "fy"].includes(normalized)) return "annual";
  if (["q", "qtr", "quarter", "quarterly"].includes(normalized)) return "quarterly";
  return undefined;
}

interface FinancialTableCellModel {
  valueText: string;
  growthText: string;
  value: number | undefined;
  growth: number | undefined;
  semanticGrowth: number | undefined;
}

interface FinancialTableModelRow {
  kind: FinancialTableRow["kind"];
  id: string;
  key?: keyof FinancialStatement;
  summaryKey?: keyof FinancialStatement;
  label: string;
  unitLabel: string;
  /** How the row's figures read: money or a share count (`compact`), per-share earnings, or a percent of a fraction. */
  format: FinancialMetricFormat;
  /** What a `compact` figure is divided by to read in the row's unit (1e9 for `bn`). */
  divisor: number;
  /** The money unit word the figures are in (`bn`); null for share counts, per-share figures and percents. */
  moneyUnit: string | null;
  depth: number;
  growthDirection: FinancialGrowthDirection;
  cells: FinancialTableCellModel[];
}

export interface FinancialTableModel {
  period: FinancialPeriod;
  subTab: FinancialSubTab;
  statements: FinancialTableStatement[];
  rows: FinancialTableModelRow[];
  /** Money unit word the rows share (`bn`), stated once beside the currency. */
  unit: string | undefined;
  /** The newest periods left out because they are not in yet (selectFinancialStatements), for notInYetNote. */
  notInYet: FinancialTableStatement[];
  /** The newer quarters the TTM column passed over, not in yet, for trailingNotInYetNote. */
  trailingNotInYet: FinancialStatement[];
}

/** Counts of the shares a company has issued or has outstanding, which are never zero; treasury shares can be. */
const OUTSTANDING_COUNT_FIELDS = ["basicShares", "dilutedShares", "shareIssued", "ordinarySharesNumber"] as const;

/**
 * Share counts that cannot be the company's: zero, or under a thousandth of its
 * typical count (IAG's 4,642 for Q3 2025, millions read as shares, which shows
 * as 0.00 bn and a fall of 100%). They are missing, not a value to grow from.
 */
function withoutImpossibleShareCounts(
  annualStatements: FinancialStatement[],
  quarterlyStatements: FinancialStatement[],
): { annualStatements: FinancialStatement[]; quarterlyStatements: FinancialStatement[] } {
  const all = [...annualStatements, ...quarterlyStatements];
  const floors = new Map<string, number>();
  for (const field of OUTSTANDING_COUNT_FIELDS) {
    const counts = all.map((row) => row[field]).filter((value): value is number => typeof value === "number" && value > 0).sort((a, b) => a - b);
    floors.set(field, counts.length ? counts[Math.floor(counts.length / 2)]! / 1000 : 0);
  }
  const impossible = (row: FinancialStatement, field: typeof OUTSTANDING_COUNT_FIELDS[number]) => {
    const value = row[field];
    return typeof value === "number" && (value <= 0 || value < floors.get(field)!);
  };
  const clean = (rows: FinancialStatement[]) => rows.map((row) => {
    const drop = OUTSTANDING_COUNT_FIELDS.filter((field) => impossible(row, field));
    if (!drop.length) return row;
    const next = { ...row };
    for (const field of drop) delete next[field];
    return next;
  });
  return { annualStatements: clean(annualStatements), quarterlyStatements: clean(quarterlyStatements) };
}

/**
 * The lines a quarter needs before a trailing-twelve-month column sums it, per statement: one of them at least. A
 * quarter with none (only its EPS on file, between the earnings release and the 10-Q) is not in yet. The ratio tabs
 * read Income's periods.
 */
const TTM_HEADLINES: Record<string, ReadonlyArray<keyof FinancialStatement>> = {
  income: ["totalRevenue", "operatingIncome", "netIncome"],
  cashflow: ["operatingCashFlow", "freeCashFlow"],
};

function finiteLine(statement: FinancialStatement, key: keyof FinancialStatement): boolean {
  const value = statement[key];
  return typeof value === "number" && Number.isFinite(value);
}

/** Whether a trailing column ends more than a few days after the first year shown, so it is no repeat of that year. */
function endsAfterLatestYear(ttm: FinancialTableStatement, latestYear: FinancialStatement | undefined): boolean {
  const periodEnd = ttm.aggregation?.periodEnd;
  if (!periodEnd) return false;
  if (!latestYear) return true;
  return Date.parse(periodEnd) - Date.parse(latestYear.date) > 7 * 86_400_000;
}

/**
 * A statement table's columns, newest first: a trailing-twelve-month column
 * (annual Income and Cash Flow) and the periods with a figure on the
 * statement. No column is a header over nothing: a period or a TTM with no
 * figure on this statement is left out, and so are the newest periods that
 * are not in yet (`notInYet`, splitPeriodsNotInYet: NVDA's Q3 FY27 with only
 * its EPS on file between its earnings release and its 10-Q). A TTM never sums
 * such a quarter: it runs to the latest four quarters that carry the
 * statement's lines (TTM_HEADLINES), or is Gloom Cloud's served one.
 */
export function selectFinancialStatements(
  period: FinancialPeriod,
  statement: string,
  servedAnnual: FinancialStatement[],
  servedQuarterly: FinancialStatement[],
  limit = period === "annual" ? 5 : 6,
  /** Gloom Cloud's trailing twelve months where the quarters do not give them (TickerFinancials.trailingStatement). */
  servedTrailing?: TickerFinancials["trailingStatement"],
) {
  const { annualStatements, quarterlyStatements } = withoutImpossibleShareCounts(servedAnnual, servedQuarterly);
  // A period with nothing on this statement (a fiscal year-end balance point on
  // the income statement) would render as an all-dash column.
  const tab = FINANCIAL_SUB_TABS.find((candidate) => candidate.key === statement);
  const hasFigures = (candidate: FinancialStatement) => !tab || tab.rows.some((row) => hasFinancialRowValue(row, [candidate]));
  const { shown, notInYet } = splitPeriodsNotInYet(
    (period === "annual" ? annualStatements : quarterlyStatements).filter(hasFigures).reverse(),
    tab ?? { rows: [] },
  );
  const rawStatements = shown.slice(0, limit);
  const trailingStatement = period === "annual" && statement !== "balance";
  const headlines = TTM_HEADLINES[statement] ?? TTM_HEADLINES.income!;
  const carriesHeadline = (quarter: FinancialStatement) => headlines.some((key) => finiteLine(quarter, key));
  // A company whose quarters carry none of these lines keeps the four latest, as before.
  const complete = quarterlyStatements.some(carriesHeadline) ? carriesHeadline : undefined;
  const fromQuarters = trailingStatement ? computeTTM(quarterlyStatements, annualStatements, complete) : null;
  const served = trailingStatement ? servedTrailingStatement(servedTrailing, annualStatements) : null;
  // The newer of the two: four quarters, or the year plus the half since it. To the same day, the served
  // one where a quarter lacks a headline line the four would need (Meituan's Q3 2025 revenue).
  const quartersEnd = (fromQuarters?.aggregation?.periodEnd ?? "").slice(0, 10);
  const servedEnd = (served?.aggregation?.periodEnd ?? "").slice(0, 10);
  // Two ends a few days apart are one period (a quarter dated 2025-06-28 and a half to 2025-06-30).
  const sameEnd = !!fromQuarters && !!served && areNearbyFinancialPeriodEnds(servedEnd, quartersEnd);
  // To the same day, the served one too where the four quarters would mix two definitions of a line
  // (a bank's revenue before credit losses in its announcements, after them at the statements source).
  const trailing = served && (!fromQuarters || (!sameEnd && servedEnd > quartersEnd)
    || (sameEnd && (lacksHeadline(fromQuarters, served) || !!servedTrailing?.trailing.overQuarters)))
    ? served
    : fromQuarters;
  // Right after a fiscal year closes, the last four quarters are that year:
  // the reported year is shown, not a second column of the same period. Nor is
  // one that ends before it, or one with nothing on this statement.
  const ttm = trailing && endsAfterLatestYear(trailing, rawStatements[0]) && hasFigures(trailing) ? trailing : null;
  // The newer quarters a TTM summed from quarters passed over for want of the statement's lines
  // (trailingNotInYetNote); none where it stops for another reason, as a quarter missing from the list.
  const periodEnd = ttm?.aggregation?.periodEnd;
  const newer = ttm && ttm === fromQuarters && complete && periodEnd ? quarterlyStatements.filter((quarter) => quarter.date > periodEnd) : [];
  const passedOver = newer.every((quarter) => !complete?.(quarter)) ? newer.reverse() : [];
  const previousStatementMap = buildPreviousStatementMap(period, annualStatements, quarterlyStatements, ttm);
  const statements: FinancialTableStatement[] = ttm ? [ttm, ...rawStatements] : rawStatements;

  // A balance sheet is a dated snapshot. It needs neither a four-quarter sum
  // nor four reports before the latest position can be compared with year end.
  if (period === "annual" && statement === "balance") {
    const balanceRows = FINANCIAL_SUB_TABS.find((tab) => tab.key === "balance")!.rows;
    // Coverage arrives by metric: a newer EPS-only row is not a balance sheet.
    const latest = quarterlyStatements.findLast((candidate) => (
      balanceRows.some((row) => hasFinancialRowValue(row, [candidate]))
    ));
    if (latest && latest.date > (annualStatements.at(-1)?.date ?? "")) {
      statements.unshift(latest);
      const previous = [...quarterlyStatements].reverse().find((candidate) => {
        const days = (Date.parse(latest.date) - Date.parse(candidate.date)) / 86_400_000;
        return days >= 350 && days <= 380;
      });
      if (previous) previousStatementMap.set(latest.date, previous);
    }
  }
  return { statements, previousStatementMap, notInYet, trailingNotInYet: passedOver };
}

/** Whether four quarters summed lack a headline line the served TTM has. */
function lacksHeadline(quarters: FinancialStatement, served: FinancialStatement): boolean {
  return (["totalRevenue", "netIncome", "operatingCashFlow"] as const)
    .some((key) => !Number.isFinite(quarters[key]) && Number.isFinite(served[key]));
}

export function buildFinancialTableModel(
  financials: Pick<TickerFinancials, "annualStatements" | "quarterlyStatements" | "financialCurrency" | "fundamentals" | "trailingStatement"> | null | undefined,
  options: {
    period?: FinancialPeriod;
    statement?: string;
    annualLimit?: number;
    quarterlyLimit?: number;
    collapsedGroupIds?: Iterable<string>;
    expandAll?: boolean;
  } = {},
): FinancialTableModel | null {
  const annualStatements = [...(financials?.annualStatements ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const quarterlyStatements = [...(financials?.quarterlyStatements ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const hasAnnualStatements = annualStatements.length > 0;
  const hasQuarterlyStatements = quarterlyStatements.length > 0;
  if (!hasAnnualStatements && !hasQuarterlyStatements) return null;
  const comparisonCurrency = financialStatementCurrency(financials, [...annualStatements, ...quarterlyStatements]);

  const requestedPeriod = options.period ?? (hasAnnualStatements ? "annual" : "quarterly");
  const period = resolveFinancialPeriod(requestedPeriod, hasAnnualStatements, hasQuarterlyStatements);
  const subTabKey = resolveFinancialSubTabKey(options.statement);
  const { statements, previousStatementMap, notInYet, trailingNotInYet } = selectFinancialStatements(
    period, subTabKey, annualStatements, quarterlyStatements,
    period === "annual" ? options.annualLimit : options.quarterlyLimit,
    financials?.trailingStatement,
  );
  const subTab = FINANCIAL_SUB_TABS.find((tab) => tab.key === subTabKey) ?? FINANCIAL_SUB_TABS[0]!;
  const collapsedGroups = options.expandAll
    ? new Set<string>()
    : new Set(options.collapsedGroupIds ?? collectDefaultCollapsedGroupIds(subTab.rows));
  const { rows: tableRows, unit } = shareFinancialUnit(buildFinancialRows(subTab.rows, statements, collapsedGroups));
  const rows = tableRows.map((row): FinancialTableModelRow => {
    const cells = statements.map((statement) => {
      const { value, formattedValue, growth } = financialCellParts(row, statement, previousStatementMap.get(statement.date), comparisonCurrency);
      return {
        ...formatFinancialCell(formattedValue, growth),
        value,
        // A number, or null with the cell's growth text reading N/M.
        growth: typeof growth === "number" ? growth : undefined,
        semanticGrowth: semanticGrowthValue(growth, row.growthDirection),
      };
    });
    return {
      kind: row.kind,
      id: row.id,
      key: row.kind === "metric" ? row.key : undefined,
      summaryKey: row.kind === "group" ? row.summaryKey : undefined,
      label: row.label,
      unitLabel: row.unitLabel,
      format: row.format,
      divisor: row.divisor,
      moneyUnit: row.moneyUnit,
      depth: row.depth,
      growthDirection: row.growthDirection,
      cells,
    };
  });

  return { period, subTab, statements, rows, unit, notInYet, trailingNotInYet };
}

/**
 * A statement table's columns for stalePeriodNote, each with whether the
 * statement's lead line (its first: revenue, total assets, free cash flow)
 * has a figure in it, so a newer column with only some figures (an EPS
 * alone) is not read as the latest period.
 */
export function financialStatementPeriods(
  statements: readonly FinancialTableStatement[],
  subTab: Pick<FinancialSubTab, "rows">,
): Array<{ date: string; lead: boolean }> {
  const lead = subTab.rows[0];
  return statements.map((statement) => ({ date: statement.date, lead: !!lead && hasLeadLine(lead, statement) }));
}

/**
 * A period is ready when its lead line is present, intentionally omitted, or accompanied by a filed
 * income or cash flow figure. Banks' filings can report net income under a separate revenue convention.
 */
function hasLeadLine(lead: FinancialRowDef, statement: FinancialStatement): boolean {
  if (hasFinancialRowValue(lead, [statement])) return true;
  const key = isFinancialGroup(lead) ? lead.summaryKey : lead.key;
  const fill = statement.filledFrom;
  if (!key || fill?.source !== "results") return false;
  if (fill.omitted?.some((field) => field === key)) return true;
  const filedLine = key === "totalRevenue" ? "netIncome" : key === "freeCashFlow" ? "operatingCashFlow" : undefined;
  if (!filedLine || !fill.fields.includes(filedLine) || !Number.isFinite(statement[filedLine])) return false;
  const document = fill.lines[filedLine]?.document;
  const url = document === undefined ? undefined : fill.documents[document]?.url;
  return typeof url === "string" && !!safeExternalUrl(url);
}

/**
 * The newest periods of a statement table that are not in yet: those before
 * the newest with the statement's lead line (revenue, total assets, free
 * cash flow), which hold only some figures (an EPS alone, as Pop Mart's
 * FY2025 did before its statements were filled). The pane leaves them out of
 * its columns and says so in `notInYetNote`, so the first column is never
 * an all-dash one. A trailing-twelve-month column is kept: it is summed, and
 * so is a period whose lead line was left blank on purpose (`hasLeadLine`).
 */
export function splitPeriodsNotInYet<T extends FinancialTableStatement>(
  statements: readonly T[],
  subTab: Pick<FinancialSubTab, "rows">,
): { shown: T[]; notInYet: T[] } {
  const lead = subTab.rows[0];
  const notInYet: T[] = [];
  for (const statement of statements) {
    if (statement.date === "TTM") continue;
    if (!lead || hasLeadLine(lead, statement)) break;
    notInYet.push(statement);
  }
  // A table where no period has the lead line keeps what it has.
  if (notInYet.length === statements.filter((statement) => statement.date !== "TTM").length) return { shown: [...statements], notInYet: [] };
  return { shown: statements.filter((statement) => !notInYet.includes(statement)), notInYet };
}

/**
 * "FY2025 is not in yet: only some of its figures are on file, not its revenue." A quarter with only its
 * earnings per share, as one is between the earnings release and the 10-Q, keeps its EPS in the line: "Q3 FY27
 * is not in yet: only its EPS is on file (2.70 diluted), not its revenue." Null when every period is shown.
 */
export function notInYetNote(
  notInYet: readonly FinancialTableStatement[],
  subTab: Pick<FinancialSubTab, "rows">,
  kind: FinancialPeriod,
  yearEndMonth: number | null,
): string | null {
  if (!notInYet.length) return null;
  const periods = notInYet.map((statement) => financialColumnLabel(statement, kind, yearEndMonth)).reverse();
  const names = periods.length === 1 ? periods[0]! : `${periods.slice(0, -1).join(", ")} and ${periods.at(-1)}`;
  const lead = subTab.rows[0]?.label.toLowerCase();
  const leadText = lead ? `, not ${periods.length === 1 ? "its" : "their"} ${lead}` : "";
  const only = notInYet.length === 1 ? earningsOnly(notInYet[0]!, subTab) : null;
  if (only) return `${names} is not in yet: only its EPS is on file (${only}), not its ${lead ?? "statements"}.`;
  return `${names} ${periods.length === 1 ? "is" : "are"} not in yet: only some of ${periods.length === 1 ? "its" : "their"} figures are on file${leadText}.`;
}

/**
 * Why an annual table's TTM stops short of the latest quarter: "Q3 FY27 is not in yet: only its EPS is on file
 * (2.70 diluted), not its revenue, so the TTM runs to Q2 FY27." Null when it passed over none.
 */
export function trailingNotInYetNote(
  statements: readonly FinancialTableStatement[],
  passedOver: readonly FinancialStatement[],
  subTab: Pick<FinancialSubTab, "rows">,
  yearEndMonth: number | null,
): string | null {
  const ttm = statements.find((statement) => statement.date === "TTM");
  const note = ttm ? notInYetNote(passedOver, subTab, "quarterly", yearEndMonth) : null;
  return note && ttm ? `${note.slice(0, -1)}, so the TTM runs to ${financialColumnLabel(ttm, "annual", yearEndMonth).replace(/^TTM /, "")}.` : null;
}

/** A period's EPS as notInYetNote names it ("2.70 diluted"), when it has nothing on the table but EPS and share counts. */
function earningsOnly(statement: FinancialStatement, subTab: Pick<FinancialSubTab, "rows">): string | null {
  const shown = [...financialSubTabFields(subTab)].filter((field) => finiteLine(statement, field as keyof FinancialStatement));
  if (!shown.length || shown.some((field) => !SHARE_COUNT_FIELDS.has(field as keyof FinancialStatement) && !PER_SHARE_EARNINGS_FIELDS.has(field as keyof FinancialStatement))) return null;
  if (finiteLine(statement, "eps")) return `${formatPerShareNumber(statement.eps)} diluted`;
  return finiteLine(statement, "basicEps") ? `${formatPerShareNumber(statement.basicEps)} basic` : null;
}

/** The statement lines a table has a row for (filledPeriodsNote), group totals included. */
export function financialSubTabFields(subTab: Pick<FinancialSubTab, "rows">): Set<string> {
  const fields = new Set<string>();
  const visit = (rows: readonly FinancialRowDef[]) => {
    for (const row of rows) {
      if (isFinancialGroup(row)) {
        if (row.summaryKey) fields.add(row.summaryKey);
        visit(row.children);
      } else if (row.key) fields.add(row.key);
    }
  };
  visit(subTab.rows);
  return fields;
}
