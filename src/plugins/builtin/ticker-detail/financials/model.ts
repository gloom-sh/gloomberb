import type { FinancialStatement, TickerFinancials } from "../../../../types/financials";
import { formatPerShareNumber } from "../../../../utils/reported-money";
import { hasNonIncomeStatementGap } from "../../../../utils/statement-gaps";
import {
  formatGrowthShort,
  formatNumber,
  formatWithDivisor,
  padTo,
  pickUnit,
} from "../../../../utils/format";
import {
  buildPreviousStatementMap,
  computeTTM,
  type FinancialPeriod,
  type FinancialTableStatement,
} from "./aggregation";
import { FINANCIAL_SUB_TABS } from "./schema";

export { computeTTM } from "./aggregation";
export { FINANCIAL_SUB_TABS } from "./schema";
export type { FinancialPeriod } from "./aggregation";

type FinancialMetricFormat = "compact" | "eps" | "percent";
export type FinancialGrowthDirection = "higher" | "lower" | "neutral";

export type MetricDef = {
  label: string;
  key?: keyof FinancialStatement;
  id?: string;
  compute?: (statement: FinancialStatement) => number | undefined;
  format: FinancialMetricFormat;
  showGrowth?: boolean;
  growthDirection?: FinancialGrowthDirection;
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
    compute?: (statement: FinancialStatement) => number | undefined;
    label: string;
    unitLabel: string;
    /** Money unit word (`bn`) the values are in, "" for whole units; null for ratios, per-share values and share counts. */
    moneyUnit: string | null;
    divisor: number;
    format: FinancialMetricFormat;
    showGrowth: boolean;
    growthDirection: FinancialGrowthDirection;
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

export function statementMetricValue(
  def: Pick<MetricDef, "key" | "compute">,
  statement: FinancialStatement,
): number | undefined {
  const value = def.key ? statement[def.key] : def.compute?.(statement);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const FINANCIAL_COL_W = 18;
export const FINANCIAL_LABEL_W = 28;
const FINANCIAL_GROWTH_W = 7;
const FINANCIAL_VALUE_W = FINANCIAL_COL_W - FINANCIAL_GROWTH_W;

export function computeGrowth(current: number | undefined, previous: number | undefined): number | undefined {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return undefined;
  const direct = (current - previous) / Math.abs(previous);
  const growth = Number.isFinite(direct) ? direct : current / Math.abs(previous) - Math.sign(previous);
  return Number.isFinite(growth) ? growth : undefined;
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
export function canCompareFinancialRow(
  row: FinancialTableRow,
  current: FinancialStatement,
  previous: FinancialStatement | undefined,
  financialCurrency?: string,
): boolean {
  if (!previous) return false;
  const key = row.kind === "group" ? row.summaryKey : row.key;
  const sameShareBasis = current.shareBasis === previous.shareBasis;
  if (key && SHARE_COUNT_FIELDS.has(key)) return sameShareBasis;
  if (key && PER_SHARE_EARNINGS_FIELDS.has(key) && !sameShareBasis) return false;
  const currentCurrency = (current.currency ?? financialCurrency)?.trim();
  const previousCurrency = (previous.currency ?? financialCurrency)?.trim();
  return !!currentCurrency && currentCurrency === previousCurrency;
}

export function semanticGrowthValue(
  growth: number | undefined,
  direction: FinancialGrowthDirection,
): number | undefined {
  if (growth == null) return undefined;
  if (direction === "lower") return -growth;
  if (direction === "neutral") return 0;
  return growth;
}

export function formatFinancialCell(value: string, growth: number | undefined) {
  const growthText = growth != null && Number.isFinite(growth) ? formatFinancialGrowth(growth) : "";
  return {
    valueText: padTo(value, FINANCIAL_VALUE_W, "right"),
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

export function formatFinancialValue(
  value: number | undefined,
  row: Pick<FinancialTableRow, "format" | "divisor">,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (row.format === "eps") return formatPerShareNumber(value);
  if (row.format === "percent") return `${formatNumber(value * 100, 1)}%`;
  return formatWithDivisor(value, row.divisor);
}

/**
 * A statement column's header for reports. The compact form is the period as
 * the pane prints it without a fiscal calendar: `TTM`, or the period end date
 * the query bar shows as of. Table columns use `financialColumnLabel`.
 */
export function formatFinancialHeader(date: string, currency?: string, dateSource?: FinancialStatement["dateSource"], compact = false, periodEnd?: string): string {
  if (compact) return date === "TTM" ? "TTM" : date.slice(0, 10);
  const period = date === "TTM" ? (periodEnd ? `TTM ${periodEnd}` : "TTM") : date.slice(0, 10);
  const label = currency ? `${period} ${currency}` : period;
  if (date === "TTM") return label;
  return `${label} ${dateSource === "sec" ? "(SEC date)" : "(provider date)"}`;
}

/**
 * The month a period end closes. A 52/53-week period that ends in a month's
 * first week (Jan 3, 2026) closes the month before, as its filer counts it.
 */
function closingMonth(date: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  let year = Number(match[1]);
  let month = Number(match[2]);
  if (Number(match[3]) <= 7) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return month >= 1 && month <= 12 ? { year, month } : null;
}

/** The month the issuer's fiscal year ends, from its latest annual statement. */
export function fiscalYearEndMonth(annualStatements: readonly Pick<FinancialStatement, "date">[]): number | null {
  const latest = annualStatements.reduce<string | null>((max, { date }) => (!max || date > max ? date : max), null);
  return latest ? closingMonth(latest)?.month ?? null : null;
}

/**
 * A fiscal period as issuers and Bloomberg name it: `FY2026` for a year,
 * `Q4 FY26` for a quarter. A fiscal year is named by the calendar year it
 * ends in. Without a fiscal calendar, or for a period off it (a transition
 * period, an off-cycle observation), the period end date is shown instead.
 */
export function fiscalPeriodLabel(date: string, kind: FinancialPeriod, yearEndMonth: number | null): string {
  const closing = closingMonth(date);
  if (!closing || yearEndMonth == null) return date.slice(0, 10);
  const offset = (closing.month - yearEndMonth + 12) % 12;
  if (kind === "annual") return offset === 0 ? `FY${closing.year}` : date.slice(0, 10);
  if (offset % 3 !== 0) return date.slice(0, 10);
  const fiscalYear = closing.month <= yearEndMonth ? closing.year : closing.year + 1;
  return `Q${offset === 0 ? 4 : offset / 3} FY${String(fiscalYear).slice(-2)}`;
}

/** A table column's label: the fiscal period, and `TTM` with the quarter it runs to. */
export function financialColumnLabel(
  statement: FinancialTableStatement,
  kind: FinancialPeriod,
  yearEndMonth: number | null,
): string {
  if (statement.date !== "TTM") return fiscalPeriodLabel(statement.date, kind, yearEndMonth);
  const periodEnd = statement.aggregation?.periodEnd;
  return periodEnd ? `TTM ${fiscalPeriodLabel(periodEnd, "quarterly", yearEndMonth)}` : "TTM";
}

/** The end of the latest period on screen, which the query bar shows as of. */
export function latestFinancialPeriodEnd(statements: readonly FinancialTableStatement[]): string | undefined {
  return statements
    .map((statement) => statement.date === "TTM" ? statement.aggregation?.periodEnd : statement.date.slice(0, 10))
    .reduce<string | undefined>((max, end) => (end && (!max || end > max) ? end : max), undefined);
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
    return statements.some((statement) => typeof statementMetricValue(row, statement) === "number");
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
 * The money unit most rows share (`bn`), said once beside the currency. Rows
 * in that unit drop their `(bn)`, and money rows too small for any unit are
 * shown in it; rows in another unit, and share counts, keep theirs.
 */
export function shareFinancialUnit<T extends { unitLabel: string; label: string; moneyUnit: string | null; divisor: number }>(
  rows: readonly T[],
): { rows: T[]; unit: string | undefined } {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.moneyUnit) counts.set(row.moneyUnit, (counts.get(row.moneyUnit) ?? 0) + 1);
  const unit = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (!unit) return { rows: [...rows], unit: undefined };
  return {
    rows: rows.map((row) => {
      if (row.moneyUnit === unit) return { ...row, unitLabel: row.label };
      if (row.moneyUnit === "") return { ...row, unitLabel: row.label, moneyUnit: unit, divisor: UNIT_DIVISORS[unit]! };
      return row;
    }),
    unit,
  };
}

export function buildFinancialRows(
  defs: FinancialRowDef[],
  statements: FinancialStatement[],
  collapsedGroups: Set<string>,
  depth = 0,
): FinancialTableRow[] {
  const rows: FinancialTableRow[] = [];

  for (const def of defs) {
    if (!hasFinancialRowValue(def, statements)) continue;

    if (!isFinancialGroup(def)) {
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
        growthDirection: def.growthDirection ?? "higher",
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
      rows.push(...buildFinancialRows(children, statements, collapsedGroups, depth + 1));
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
}

function coversLatestYear(ttm: FinancialTableStatement, latestYear: FinancialStatement | undefined): boolean {
  const periodEnd = ttm.aggregation?.periodEnd;
  if (!periodEnd || !latestYear) return false;
  const days = Math.abs(Date.parse(periodEnd) - Date.parse(latestYear.date)) / 86_400_000;
  return days <= 7;
}

export function selectFinancialStatements(
  period: FinancialPeriod,
  statement: string,
  annualStatements: FinancialStatement[],
  quarterlyStatements: FinancialStatement[],
  limit = period === "annual" ? 5 : 6,
) {
  // A period with nothing on this statement (a fiscal year-end balance point on
  // the income statement) would render as an all-dash column.
  const tabRows = FINANCIAL_SUB_TABS.find((tab) => tab.key === statement)?.rows;
  const rawStatements = (period === "annual" ? annualStatements : quarterlyStatements)
    .filter((candidate) => !tabRows || tabRows.some((row) => hasFinancialRowValue(row, [candidate])))
    .slice(-limit)
    .reverse();
  const trailing = period === "annual" && statement !== "balance" ? computeTTM(quarterlyStatements) : null;
  // Right after a fiscal year closes, the last four quarters are that year:
  // the reported year is shown, not a second column of the same period.
  const ttm = trailing && !coversLatestYear(trailing, rawStatements[0]) ? trailing : null;
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
  return { statements, previousStatementMap };
}

export function buildFinancialTableModel(
  financials: Pick<TickerFinancials, "annualStatements" | "quarterlyStatements" | "financialCurrency" | "fundamentals"> | null | undefined,
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
  const { statements, previousStatementMap } = selectFinancialStatements(
    period, subTabKey, annualStatements, quarterlyStatements,
    period === "annual" ? options.annualLimit : options.quarterlyLimit,
  );
  const subTab = FINANCIAL_SUB_TABS.find((tab) => tab.key === subTabKey) ?? FINANCIAL_SUB_TABS[0]!;
  const collapsedGroups = options.expandAll
    ? new Set<string>()
    : new Set(options.collapsedGroupIds ?? collectDefaultCollapsedGroupIds(subTab.rows));
  const { rows: tableRows, unit } = shareFinancialUnit(buildFinancialRows(subTab.rows, statements, collapsedGroups));
  const rows = tableRows.map((row): FinancialTableModelRow => {
    const cells = statements.map((statement) => {
      const previous = previousStatementMap.get(statement.date);
      const value = row.kind === "group"
        ? row.summaryKey ? statement[row.summaryKey] as number | undefined : undefined
        : statementMetricValue(row, statement);
      const previousValue = previous
        ? row.kind === "group"
          ? row.summaryKey ? previous[row.summaryKey] as number | undefined : undefined
          : statementMetricValue(row, previous)
        : undefined;
      const growth = (row.kind === "metric" && !row.showGrowth)
        || !canCompareFinancialRow(row, statement, previous, comparisonCurrency)
        ? undefined : computeGrowth(value, previousValue);
      return {
        ...formatFinancialCell(formatFinancialValue(value, row), growth),
        value,
        growth,
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
      depth: row.depth,
      growthDirection: row.growthDirection,
      cells,
    };
  });

  return { period, subTab, statements, rows, unit };
}
