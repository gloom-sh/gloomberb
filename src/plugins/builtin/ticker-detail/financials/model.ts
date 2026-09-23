import type { FinancialStatement, TickerFinancials } from "../../../../types/financials";
import { formatPerShareNumber } from "../../../../utils/reported-money";
import { operatingResultDisagrees } from "../../../../utils/operating-result";
import { canCompareOperatingField } from "../../../../utils/operating-result-aggregation";
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

export { buildPreviousStatementMap, computeTTM } from "./aggregation";
export { FINANCIAL_SUB_TABS, FINANCIAL_SUB_TABS_WIDTH } from "./schema";
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
    unitLabel: string;
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

export const FINANCIAL_PERIOD_TABS_WIDTH = "Annual".length + "Quarterly".length + 4;

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

/** Currency changes affect monetary comparisons, not counts of reported shares. */
export function canCompareFinancialRow(
  row: FinancialTableRow,
  current: FinancialStatement,
  previous: FinancialStatement | undefined,
  financialCurrency?: string,
): boolean {
  if (!previous) return false;
  const key = row.kind === "group" ? row.summaryKey : row.key;
  if (key && SHARE_COUNT_FIELDS.has(key)) return true;
  const operatingKey = key ?? (row.id.split(":")[0] === "gross-margin" ? "grossProfit"
    : row.id.split(":")[0] === "operating-margin" ? "operatingIncome" : undefined);
  if (operatingKey && !canCompareOperatingField(current, previous, operatingKey)) return false;
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

export function formatFinancialHeader(date: string, currency?: string, dateSource?: FinancialStatement["dateSource"], compact = false, periodEnd?: string): string {
  const period = date === "TTM" ? (periodEnd ? `TTM ${periodEnd}` : "TTM") : date.slice(0, 10);
  const label = currency ? `${period} ${currency}` : period;
  if (date === "TTM") return label;
  return `${label} ${compact ? (dateSource === "sec" ? "S" : "P") : (dateSource === "sec" ? "(SEC date)" : "(provider date)")}`;
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
  const industry = financials?.profile?.industry ?? "";
  const records = [financials?.fundamentals, ...(financials?.annualStatements ?? []), ...(financials?.quarterlyStatements ?? [])];
  const hasMetric = (keys: string[]) => records.some((record) => keys.some((key) => {
    const value = (record as Record<string, unknown> | undefined)?.[key];
    return typeof value === "number" && Number.isFinite(value);
  }));
  const limitations: string[] = [];
  const operatingNotice = financialOperatingSourceNotice(financials);
  if (operatingNotice) limitations.push(operatingNotice);
  if ([...(financials?.annualStatements ?? []), ...(financials?.quarterlyStatements ?? [])].some(row => row.withdrawnObservations?.length)) {
    limitations.push("Some statement values conflict with issuer filings and are unavailable.");
  }
  if ([...(financials?.annualStatements ?? []), ...(financials?.quarterlyStatements ?? [])].some(row => row.unavailableFields?.includes("netIncome"))) {
    limitations.push("Parent net income is unavailable for some reported periods.");
  }
  if (/\breit\b/i.test(industry) && !hasMetric(["fundsFromOperations", "adjustedFundsFromOperations", "ffo", "affo"])) {
    limitations.push("FFO/AFFO are unavailable.");
  }
  if (/\bbanks?\b/i.test(industry) && !hasMetric(["commonEquityTier1Ratio", "cet1Ratio", "riskWeightedAssets"])) {
    limitations.push("Bank capital measures, including CET1 and risk-weighted assets, are unavailable.");
  }
  return limitations;
}

export function financialOperatingSourceNotice(financials: TickerFinancials | null | undefined): string | undefined {
  const statements = [...(financials?.annualStatements ?? []), ...(financials?.quarterlyStatements ?? [])];
  if (!statements.some(operatingResultDisagrees)) return undefined;
  return "Reported operating results differ from provider figures. EBITDA and Total Expenses retain their separate source definitions.";
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

function repeatsHeadline(
  line: Pick<MetricDef, "key" | "compute">,
  headline: keyof FinancialStatement,
  statements: FinancialStatement[],
): boolean {
  return statements.every((statement) => {
    const value = statementMetricValue(line, statement);
    return value === undefined || value === statementMetricValue({ key: headline }, statement);
  });
}

/**
 * Companies without minority interests or discontinued operations report the
 * net income headline again on several lines. A line that equals its group's
 * headline in every shown period where it is reported adds nothing.
 */
function distinctChildren(
  group: FinancialGroupDef,
  statements: FinancialStatement[],
): FinancialRowDef[] {
  const summaryKey = group.summaryKey;
  return group.children.filter((child) => (
    hasFinancialRowValue(child, statements)
    && (isFinancialGroup(child) || !summaryKey || child.key === summaryKey
      || !repeatsHeadline(child, summaryKey, statements))
  ));
}

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
  return {
    unitLabel: suffix ? `${label} (${suffix})` : label,
    divisor,
    format,
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
      const { unitLabel, divisor, format } = resolveMetricUnit(statements, def, def.label);
      rows.push({
        kind: "metric",
        id: `${def.id ?? String(def.key)}:${depth}`,
        key: def.key,
        compute: def.compute,
        unitLabel,
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
      : { unitLabel: def.label, divisor: 1, format: def.format ?? "compact" };

    rows.push({
      kind: "group",
      id: def.id,
      label: def.label,
      unitLabel: metricUnit.unitLabel,
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
  const ttm = period === "annual" && statement !== "balance" ? computeTTM(quarterlyStatements) : null;
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
  const rows = buildFinancialRows(subTab.rows, statements, collapsedGroups).map((row): FinancialTableModelRow => {
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
      unitLabel: row.unitLabel,
      depth: row.depth,
      growthDirection: row.growthDirection,
      cells,
    };
  });

  return { period, subTab, statements, rows };
}
