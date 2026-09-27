import type {
  FinancialStatement,
  TickerFinancials,
} from "../types/financials";
import { areNearbyFinancialPeriodEnds, completeAvailability, statementFieldAvailability } from "../utils/financial-statements";
import { copyIncomeField, incomeFieldKnowledgeDate, incomeFieldOwner, isIncomeStatementField } from "../utils/income-statement";
import { hasStatementGap, mergeStatementGaps } from "../utils/statement-gaps";
import { canonicalTimeSeriesFieldId, getTimeSeriesField } from "./field-catalog";
import { forwardPeHistory, realizedNtmPeHistory } from "./forward-valuation";
import { reportingCurrencySeries } from "./reporting-currency";
import { createValuationCurrencyContext, type ValuationCurrencyContext } from "./valuation-currency";
import { valuationPriceAtOrBefore, valuationQuoteIssue, type ValuationPriceIssue } from "./valuation-price";
import type { SecuritySeriesSource, SeriesPeriod, TimeSeriesPoint } from "./types";
import { isFiniteNumber } from "../utils/guards";

type NumericStatementField =
  | "totalRevenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "netIncomeIncludingNoncontrollingInterests"
  | "netIncomeCommonStockholders"
  | "ebitda"
  | "operatingCashFlow"
  | "capitalExpenditure"
  | "freeCashFlow"
  | "eps"
  | "totalAssets"
  | "cashAndCashEquivalents"
  | "cashCashEquivalentsAndShortTermInvestments"
  | "totalDebt"
  | "totalEquity"
  | "basicShares"
  | "dilutedShares"
  | "shareIssued"
  | "ordinarySharesNumber";

type InternalStatement = FinancialStatement & {
  __timeSeriesDerivedFields?: NumericStatementField[];
  __timeSeriesTtm?: boolean;
  __timeSeriesIncompleteCommonIncome?: boolean;
  __timeSeriesIncompleteAverageShares?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

export const QUARTERLY_FLOW_FIELDS: readonly NumericStatementField[] = [
  "totalRevenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "netIncomeIncludingNoncontrollingInterests",
  "ebitda",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
];

export const QUARTERLY_SNAPSHOT_FIELDS: readonly NumericStatementField[] = [
  "totalAssets",
  "cashAndCashEquivalents",
  "cashCashEquivalentsAndShortTermInvestments",
  "totalDebt",
  "totalEquity",
  "shareIssued",
  "ordinarySharesNumber",
];

const QUARTERLY_AVERAGE_FIELDS: readonly NumericStatementField[] = ["basicShares", "dilutedShares"];
// Reported common-income allocations and EPS may be summed for TTM, but
// independently determined annual values cannot establish a missing quarter.
const TTM_SUM_FIELDS: readonly NumericStatementField[] = [...QUARTERLY_FLOW_FIELDS, "netIncomeCommonStockholders", "eps"];

const NUMERIC_STATEMENT_FIELDS: readonly NumericStatementField[] = [
  ...QUARTERLY_FLOW_FIELDS,
  ...QUARTERLY_SNAPSHOT_FIELDS,
  ...QUARTERLY_AVERAGE_FIELDS,
  "netIncomeCommonStockholders",
  "eps",
];

const FUNDAMENTAL_IDS = new Set([
  "totalRevenue",
  "grossProfit",
  "grossMargin",
  "operatingIncome",
  "operatingMargin",
  "netIncome",
  "netMargin",
  "operatingCashFlow",
  "freeCashFlow",
  "freeCashFlowMargin",
  "totalAssets",
  "totalDebt",
  "totalEquity",
  "eps",
]);

const VALUATION_IDS = new Set([
  "trailingPE",
  "forwardPE",
  "realizedNtmPE",
  "pegRatio",
  "priceSales",
  "evSales",
  "evEbitda",
  "priceFcf",
]);

/** Statement-based multiples whose latest point is the live quote over the latest period. */
const QUOTE_DERIVED_VALUATION_IDS = new Set([
  "trailingPE",
  "priceSales",
  "evSales",
  "evEbitda",
  "priceFcf",
]);

/** Multiples priced from history at each observation date; forward P/E also ends on the live quote. */
const PRICE_HISTORY_VALUATION_IDS = new Set([
  ...QUOTE_DERIVED_VALUATION_IDS,
  "forwardPE",
  "realizedNtmPE",
]);

function validDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function statementTime(statement: FinancialStatement): number {
  return Date.parse(statement.date);
}

function statementNumber(statement: FinancialStatement, field: NumericStatementField): number | null {
  if (field === "eps" && statement.epsBasis?.status === "unresolved") return null;
  const value = statement[field];
  return isFiniteNumber(value) ? value : null;
}

function setStatementNumber(
  statement: InternalStatement,
  field: NumericStatementField,
  value: number,
  availableAt?: string,
): void {
  (statement as unknown as Record<string, unknown>)[field] = value;
  statement.__timeSeriesDerivedFields = [
    ...new Set([...(statement.__timeSeriesDerivedFields ?? []), field]),
  ];
  statement.fieldAvailability = { ...statement.fieldAvailability };
  if (availableAt) statement.fieldAvailability[field] = availableAt;
  else delete statement.fieldAvailability[field];
}

function completeStatementAvailability(statement: InternalStatement): string | undefined {
  return completeAvailability(NUMERIC_STATEMENT_FIELDS
    .filter((field) => statementNumber(statement, field) !== null)
    .map((field) => statementFieldAvailability(statement, field)));
}

/** Internal calendar bucket for selecting adjacent inputs, not an issuer fiscal label. */
function calendarQuarterBucket(date: string): string {
  const parsedYear = Number(date.slice(0, 4));
  let year = Number.isFinite(parsedYear) ? parsedYear : 0;

  let month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (Number.isFinite(month) && Number.isFinite(day) && day <= 7 && (month - 1) % 3 === 0) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  const quarter = Number.isFinite(month) && month > 0 ? Math.ceil(month / 3) : 0;
  return quarter > 0 && year > 0 ? `${year} Q${quarter}` : date;
}

function statementAvailabilityScore(statement: FinancialStatement): number {
  return Object.values(statement.fieldAvailability ?? {})
    .filter((value) => Number.isFinite(Date.parse(value)))
    .length + (Number.isFinite(Date.parse(statement.availableAt ?? "")) ? 1 : 0);
}

interface StatementFieldCandidate {
  statement: InternalStatement;
  value: number;
  availableAt?: string;
  derived: boolean;
}

function selectFieldCandidate(candidates: StatementFieldCandidate[]): StatementFieldCandidate {
  const reported = candidates.filter((candidate) => !candidate.derived);
  const qualityCandidates = reported.length > 0 ? reported : candidates;
  const dated = qualityCandidates.filter((candidate) => (
    Number.isFinite(Date.parse(candidate.availableAt ?? ""))
  ));
  const chronological = [...(dated.length > 0 ? dated : qualityCandidates)].sort((left, right) => (
    Date.parse(left.availableAt ?? "") - Date.parse(right.availableAt ?? "")
    || left.statement.date.localeCompare(right.statement.date)
  ));
  let selected = chronological[0]!;
  for (const candidate of chronological.slice(1)) {
    if (!Object.is(candidate.value, selected.value)) selected = candidate;
  }
  return selected;
}

function periodDateSource(statements: readonly InternalStatement[]): InternalStatement {
  return [...statements].sort((left, right) => {
    const availabilityDifference = statementAvailabilityScore(right) - statementAvailabilityScore(left);
    return availabilityDifference || left.date.localeCompare(right.date);
  })[0]!;
}

function mergeStatementPeriodGroup(statements: readonly InternalStatement[]): InternalStatement {
  const dateSource = periodDateSource(statements);
  const merged: InternalStatement = { date: dateSource.date, currency: dateSource.currency };
  const compatibleStatements = statements.filter((statement) => statement.currency === dateSource.currency);
  const derivedFields: NumericStatementField[] = [];
  const fieldAvailability: Record<string, string> = {};
  const record = merged as unknown as Record<string, unknown>;

  for (const field of NUMERIC_STATEMENT_FIELDS) {
    // A gap declared for the period is never filled from another report.
    if (!isIncomeStatementField(field) && compatibleStatements.some((statement) => hasStatementGap(statement, field))) continue;
    if (isIncomeStatementField(field)) {
      const qualified = compatibleStatements.filter(statement => statement.date === dateSource.date && incomeFieldOwner(field, statement));
      if (qualified.length) {
        const owner = [...qualified].sort((left, right) => incomeFieldKnowledgeDate(right, field).localeCompare(incomeFieldKnowledgeDate(left, field)))[0]!;
        copyIncomeField(merged, owner, field);
        const availability = statementFieldAvailability(owner, field);
        if (typeof merged[field] === "number" && availability) fieldAvailability[field] = availability;
        continue;
      }
    }
    const candidates = compatibleStatements.flatMap((statement): StatementFieldCandidate[] => {
      if (isIncomeStatementField(field) && statement.date !== dateSource.date
        && incomeFieldOwner(field, statement)) return [];
      const value = statementNumber(statement, field);
      if (value === null) return [];
      return [{
        statement,
        value,
        availableAt: statementFieldAvailability(statement, field),
        derived: statement.__timeSeriesDerivedFields?.includes(field) === true,
      }];
    });
    const verifiedEps = field === "eps" ? candidates.filter((candidate) => candidate.statement.epsBasis?.status === "split-adjusted") : [];
    const unresolvedEps = field === "eps" ? compatibleStatements.find((statement) => statement.epsBasis?.status === "unresolved") : undefined;
    if (unresolvedEps && verifiedEps.length === 0) {
      merged.epsBasis = unresolvedEps.epsBasis;
      continue;
    }
    if (candidates.length === 0) continue;
    const selected = selectFieldCandidate(verifiedEps.length ? verifiedEps : candidates);
    record[field] = selected.value;
    if (field === "eps" && selected.statement.epsBasis) merged.epsBasis = selected.statement.epsBasis;
    if (selected.availableAt) fieldAvailability[field] = selected.availableAt;
    if (selected.derived) derivedFields.push(field);
  }

  mergeStatementGaps(merged, compatibleStatements);
  merged.fieldAvailability = fieldAvailability;
  merged.availableAt = completeStatementAvailability(merged);
  if (NUMERIC_STATEMENT_FIELDS.every(field => statementNumber(merged, field) === null)) {
    // Even an empty statement can establish when a missing period became
    // known. Its empty field map still cannot date any numeric metric.
    merged.availableAt = completeAvailability([dateSource.availableAt]);
  }
  if (derivedFields.length > 0) merged.__timeSeriesDerivedFields = derivedFields;
  return merged;
}

function mergeStatementsByPeriod(
  statements: readonly FinancialStatement[],
): InternalStatement[] {
  const groups: InternalStatement[][] = [];
  const sorted = [...statements].sort((left, right) => left.date.localeCompare(right.date));
  for (const statement of sorted) {
    const lastGroup = groups.at(-1);
    if (lastGroup && areNearbyFinancialPeriodEnds(lastGroup[0]!.date, statement.date)) {
      lastGroup.push(statement as InternalStatement);
    } else groups.push([statement as InternalStatement]);
  }
  return groups
    .map(mergeStatementPeriodGroup)
    .sort((left, right) => left.date.localeCompare(right.date));
}

interface PrecedingQuarterInput {
  date: string;
  time: number;
  value: number;
  availableAt?: string;
}

function precedingQuarterInputs(
  quarterlyStatements: readonly FinancialStatement[],
  annualStatement: FinancialStatement,
  field: NumericStatementField,
): PrecedingQuarterInput[] {
  const annualTime = statementTime(annualStatement);
  if (!Number.isFinite(annualTime)) return [];

  const annualCategory = calendarQuarterBucket(annualStatement.date);
  const byCategory = new Map<string, PrecedingQuarterInput>();
  for (const statement of quarterlyStatements) {
    if (statement.currency !== annualStatement.currency) continue;
    const time = statementTime(statement);
    if (!Number.isFinite(time) || time >= annualTime || annualTime - time > 370 * DAY_MS) continue;
    const category = calendarQuarterBucket(statement.date);
    if (category === annualCategory) continue;
    const value = statementNumber(statement, field);
    if (value === null) continue;
    const previous = byCategory.get(category);
    if (!previous || statement.date.localeCompare(previous.date) > 0) {
      byCategory.set(category, {
        date: statement.date,
        time,
        value,
        availableAt: statementFieldAvailability(statement, field),
      });
    }
  }

  return [...byCategory.values()]
    .sort((left, right) => right.time - left.time)
    .slice(0, 3)
    .sort((left, right) => left.time - right.time);
}

/**
 * Completes additive fiscal Q4 flows from the annual total and three reported
 * quarters. EPS and weighted-average shares require reported quarter values;
 * neither is an additive flow. Snapshots come from the annual balance sheet. Derived
 * values become available only after the annual total and every quarterly
 * input used in the derivation are public.
 */
export function deriveQuarterlyStatements(
  quarterlyStatements: readonly FinancialStatement[],
  annualStatements: readonly FinancialStatement[],
): FinancialStatement[] {
  const mergedQuarterly = mergeStatementsByPeriod(quarterlyStatements);
  const byDate = new Map(mergedQuarterly.map((statement) => [statement.date, { ...statement }]));

  for (const annualStatement of mergeStatementsByPeriod(annualStatements)) {
    let target: InternalStatement = byDate.get(annualStatement.date) ?? { date: annualStatement.date, currency: annualStatement.currency };
    if (target.currency !== annualStatement.currency) continue;
    let changed = false;

    for (const field of QUARTERLY_FLOW_FIELDS) {
      // A line unavailable for the fourth quarter stays a gap: the full year
      // minus the other quarters would recreate the value a source withheld.
      if (hasStatementGap(target, field) || mergedQuarterly.some((statement) => (
        areNearbyFinancialPeriodEnds(statement.date, annualStatement.date) && hasStatementGap(statement, field)
      ))) continue;
      if (statementNumber(target, field) !== null) continue;
      const annualValue = statementNumber(annualStatement, field);
      if (annualValue === null) continue;
      const previousInputs = precedingQuarterInputs(mergedQuarterly, annualStatement, field);
      if (previousInputs.length !== 3) continue;
      const inputTimes = [...previousInputs.map((input) => input.time), statementTime(annualStatement)];
      if (inputTimes.some((time, index) => index > 0 && (time - inputTimes[index - 1]! < 60 * DAY_MS || time - inputTimes[index - 1]! > 120 * DAY_MS))) continue;
      const derived = annualValue - previousInputs.reduce((sum, input) => sum + input.value, 0);
      if (!Number.isFinite(derived)) continue;
      const availableAt = completeAvailability([
        statementFieldAvailability(annualStatement, field),
        ...previousInputs.map((input) => input.availableAt),
      ]);
      setStatementNumber(target, field, derived, availableAt);
      changed = true;
    }

    for (const field of QUARTERLY_SNAPSHOT_FIELDS) {
      if (statementNumber(target, field) !== null) continue;
      const annualValue = statementNumber(annualStatement, field);
      if (annualValue === null) continue;
      const availableAt = statementFieldAvailability(annualStatement, field);
      setStatementNumber(target, field, annualValue, availableAt);
      changed = true;
    }

    if (changed) {
      target.availableAt = completeStatementAvailability(target);
      byDate.set(target.date, target);
    }
  }

  return mergeStatementsByPeriod([...byDate.values()]);
}

function buildTtmStatements(statements: readonly FinancialStatement[]): InternalStatement[] {
  const sorted = mergeStatementsByPeriod(statements);
  const result: InternalStatement[] = [];
  for (let index = 3; index < sorted.length; index += 1) {
    const window = sorted.slice(index - 3, index + 1);
    const latest = window.at(-1)!;
    const times = window.map(statementTime);
    if (new Set(window.map((statement) => statement.currency)).size > 1
      || times.some((time, index) => !Number.isFinite(time) || (index > 0 && (time - times[index - 1]! < 60 * DAY_MS || time - times[index - 1]! > 120 * DAY_MS)))) {
      // Retain the known period as a gap. Removing an incomplete window joins
      // the last usable TTM observation to the first recovered one.
      result.push({ date: latest.date, currency: latest.currency, availableAt: latest.availableAt,
        __timeSeriesTtm: true });
      continue;
    }

    const ttm: InternalStatement = {
      date: latest.date,
      currency: latest.currency,
      fieldAvailability: {},
      __timeSeriesTtm: true,
      __timeSeriesDerivedFields: [],
    };
    const unresolvedEps = window.find((statement) => statement.epsBasis?.status === "unresolved");
    if (unresolvedEps) ttm.epsBasis = unresolvedEps.epsBasis;
    const commonIncomeCount = window.filter((statement) => isFiniteNumber(statement.netIncomeCommonStockholders)).length;
    // Known common claims in some quarters cannot be ignored by substituting
    // aggregate income for the entire window or only its missing quarters.
    if ((commonIncomeCount > 0 && commonIncomeCount < window.length)
      || window.some(statement => statement.unavailableFields?.includes("netIncomeCommonStockholders"))) ttm.__timeSeriesIncompleteCommonIncome = true;
    const hasAverageShareInputs = window.some(statement => QUARTERLY_AVERAGE_FIELDS
      .some(field => statementNumber(statement, field) !== null));
    const hasCompleteAverageShares = QUARTERLY_AVERAGE_FIELDS.some(field => window.every(statement => {
      const value = statementNumber(statement, field);
      return value !== null && value > 0;
    }));
    // A missing quarter cannot replace a known weighted-period denominator
    // with a year-end ordinary/issued-share snapshot. Capitalization may still
    // use the snapshot; this guard is specific to the fallback earnings ratio.
    if (hasAverageShareInputs && !hasCompleteAverageShares) ttm.__timeSeriesIncompleteAverageShares = true;

    for (const field of [...TTM_SUM_FIELDS, ...QUARTERLY_AVERAGE_FIELDS]) {
      const values = window.map((statement) => statementNumber(statement, field));
      if (!values.every((value): value is number => value !== null)) continue;
      if (QUARTERLY_AVERAGE_FIELDS.includes(field) && !values.every(value => value > 0)) continue;
      (ttm as unknown as Record<string, unknown>)[field] = values.reduce((sum, value) => sum + value, 0)
        / (QUARTERLY_AVERAGE_FIELDS.includes(field) ? 4 : 1);
      ttm.__timeSeriesDerivedFields!.push(field);
      const availableAt = completeAvailability(window.map((statement) => (
        statementFieldAvailability(statement, field)
      )));
      if (availableAt) ttm.fieldAvailability![field] = availableAt;
    }

    for (const field of QUARTERLY_SNAPSHOT_FIELDS) {
      const value = statementNumber(latest, field);
      if (value === null) continue;
      (ttm as unknown as Record<string, unknown>)[field] = value;
      const availableAt = statementFieldAvailability(latest, field);
      if (availableAt) ttm.fieldAvailability![field] = availableAt;
    }
    ttm.availableAt = completeStatementAvailability(ttm);
    result.push(ttm);
  }
  return result;
}

function normalizeFundamentalPeriod(period: SeriesPeriod | undefined): "annual" | "quarterly" | "ttm" | "auto" {
  return period === "annual" || period === "quarterly" || period === "ttm" ? period : "auto";
}

function sourceStatements(
  financials: TickerFinancials,
  period: SeriesPeriod | undefined,
  valuationMetric?: string,
): { statements: InternalStatement[]; period: "annual" | "quarterly" | "ttm" } {
  const normalized = normalizeFundamentalPeriod(period);
  const quarterly = deriveQuarterlyStatements(financials.quarterlyStatements, financials.annualStatements);
  if (normalized === "annual") {
    return { statements: mergeStatementsByPeriod(financials.annualStatements), period: "annual" };
  }
  if (normalized === "ttm" || valuationMetric) {
    const ttm = buildTtmStatements(quarterly);
    if (normalized === "ttm" && ttm.length > 0) return { statements: ttm, period: "ttm" };
    if (valuationMetric && ttm.some((statement) => hasValuationInputs(statement, valuationMetric))) {
      return { statements: ttm, period: "ttm" };
    }
    if (normalized === "ttm") return { statements: [], period: "ttm" };
    if (valuationMetric) {
      return { statements: mergeStatementsByPeriod(financials.annualStatements), period: "annual" };
    }
  }
  if (normalized === "quarterly" || (normalized === "auto" && quarterly.length > 0)) {
    return { statements: quarterly, period: "quarterly" };
  }
  return { statements: mergeStatementsByPeriod(financials.annualStatements), period: "annual" };
}

function ratio(numerator: unknown, denominator: unknown): number | null {
  return isFiniteNumber(numerator) && isFiniteNumber(denominator) && denominator !== 0
    ? numerator / denominator
    : null;
}

function freeCashFlow(statement: FinancialStatement): { value: number | null; derived: boolean } {
  if (isFiniteNumber(statement.freeCashFlow)) return { value: statement.freeCashFlow, derived: false };
  if (isFiniteNumber(statement.operatingCashFlow) && isFiniteNumber(statement.capitalExpenditure)) {
    return { value: statement.operatingCashFlow + statement.capitalExpenditure, derived: true };
  }
  return { value: null, derived: false };
}

type SelectedStatementField = {
  field: NumericStatementField;
  value: number;
};

function selectStatementField(
  statement: FinancialStatement,
  fields: readonly NumericStatementField[],
  accepts: (value: number) => boolean = () => true,
): SelectedStatementField | null {
  for (const field of fields) {
    const value = statementNumber(statement, field);
    if (value !== null && accepts(value)) return { field, value };
  }
  return null;
}

function selectedShares(statement: FinancialStatement): SelectedStatementField | null {
  return selectStatementField(
    statement,
    ["dilutedShares", "basicShares", "ordinarySharesNumber", "shareIssued"],
    (value) => value > 0,
  );
}

function selectedCash(statement: FinancialStatement): SelectedStatementField | null {
  return selectStatementField(statement, [
    "cashCashEquivalentsAndShortTermInvestments",
    "cashAndCashEquivalents",
  ]);
}

function selectedEps(
  statement: InternalStatement,
): { value: number; dependencies: NumericStatementField[] } | null {
  if (statement.epsBasis?.status === "unresolved" || hasStatementGap(statement, "eps")) return null;
  if (isFiniteNumber(statement.eps)) {
    return { value: statement.eps, dependencies: ["eps"] };
  }
  if (statement.__timeSeriesIncompleteCommonIncome || statement.__timeSeriesIncompleteAverageShares
    || statement.unavailableFields?.includes("netIncomeCommonStockholders")) return null;
  const shares = selectedShares(statement);
  const income = selectStatementField(statement, ["netIncomeCommonStockholders", "netIncome"]);
  if (!shares || !income) return null;
  return {
    value: income.value / shares.value,
    dependencies: [income.field, shares.field],
  };
}

function uniqueDependencies(
  fields: Array<NumericStatementField | null | undefined>,
): NumericStatementField[] {
  return [...new Set(fields.filter((field): field is NumericStatementField => !!field))];
}

function metricDependencies(metric: string, statement: FinancialStatement): NumericStatementField[] {
  if (metric === "grossMargin") return ["grossProfit", "totalRevenue"];
  if (metric === "operatingMargin") return ["operatingIncome", "totalRevenue"];
  if (metric === "netMargin") return ["netIncome", "totalRevenue"];
  if (metric === "freeCashFlowMargin") {
    return isFiniteNumber(statement.freeCashFlow)
      ? ["freeCashFlow", "totalRevenue"]
      : ["operatingCashFlow", "capitalExpenditure", "totalRevenue"];
  }
  if (metric === "freeCashFlow") {
    return isFiniteNumber(statement.freeCashFlow)
      ? ["freeCashFlow"]
      : ["operatingCashFlow", "capitalExpenditure"];
  }
  if (metric === "trailingPE") return selectedEps(statement)?.dependencies ?? ["eps"];
  if (metric === "priceSales") {
    return uniqueDependencies(["totalRevenue", selectedShares(statement)?.field]);
  }
  if (metric === "evSales") {
    return uniqueDependencies([
      "totalRevenue",
      selectedShares(statement)?.field,
      "totalDebt",
      selectedCash(statement)?.field,
    ]);
  }
  if (metric === "evEbitda") {
    return uniqueDependencies([
      "ebitda",
      selectedShares(statement)?.field,
      "totalDebt",
      selectedCash(statement)?.field,
    ]);
  }
  if (metric === "priceFcf") {
    return uniqueDependencies([
      ...(isFiniteNumber(statement.freeCashFlow)
        ? ["freeCashFlow" as const]
        : ["operatingCashFlow" as const, "capitalExpenditure" as const]),
      selectedShares(statement)?.field,
    ]);
  }
  return [metric as NumericStatementField];
}

function metricAvailability(statement: FinancialStatement, metric: string): string | undefined {
  const dependencies = metricDependencies(metric, statement);
  return completeAvailability(dependencies.map((field) => statementFieldAvailability(statement, field)));
}

function fundamentalValue(
  statement: InternalStatement,
  metric: string,
): { value: number | null; derived: boolean } {
  if (metric === "grossMargin") {
    const value = ratio(statement.grossProfit, statement.totalRevenue);
    return { value: value === null ? null : value * 100, derived: true };
  }
  if (metric === "operatingMargin") {
    const value = ratio(statement.operatingIncome, statement.totalRevenue);
    return { value: value === null ? null : value * 100, derived: true };
  }
  if (metric === "netMargin") {
    const value = ratio(statement.netIncome, statement.totalRevenue);
    return { value: value === null ? null : value * 100, derived: true };
  }
  if (metric === "freeCashFlow" || metric === "freeCashFlowMargin") {
    const fcf = freeCashFlow(statement);
    if (metric === "freeCashFlow") return fcf;
    const value = ratio(fcf.value, statement.totalRevenue);
    return { value: value === null ? null : value * 100, derived: true };
  }
  const value = statementNumber(statement, metric as NumericStatementField);
  const derived = statement.__timeSeriesTtm === true
    || statement.__timeSeriesDerivedFields?.includes(metric as NumericStatementField) === true;
  return { value, derived };
}

function pointForStatement(
  statement: FinancialStatement,
  metric: string,
  value: number | null,
  period: "annual" | "quarterly" | "ttm",
  timestampMode: SecuritySeriesSource["timestampMode"],
  derived: boolean,
): TimeSeriesPoint | null {
  const observedAt = validDate(statement.date);
  if (!observedAt) return null;
  // A missing metric is known to be unavailable with its statement. It has
  // no metric-specific publication date to substitute for that boundary.
  const availableAtString = metricAvailability(statement, metric)
    ?? (value === null ? statement.availableAt : undefined);
  const availableAt = validDate(availableAtString);
  const date = timestampMode !== "period-end" && availableAt ? availableAt : observedAt;
  return {
    date,
    observedAt,
    availableAt: availableAt ?? undefined,
    value,
    // Providers do not supply a reliable issuer fiscal-year/quarter identity.
    // Calendar-month numbering would mislabel non-calendar fiscal years.
    periodLabel: `${period === "annual" ? "Year" : period === "ttm" ? "TTM" : "Quarter"} ended ${statement.date}`,
    provenance: {
      quality: derived || (metric === "eps" && statement.epsBasis?.factor !== undefined && statement.epsBasis.factor !== 1) ? "derived" : "reported",
      ...((metric === "eps" || metric === "trailingPE") && statement.epsBasis ? { secEpsBasis: statement.epsBasis } : {}),
      ...((metric === "eps" || metric === "trailingPE") && hasStatementGap(statement, "eps")
        ? { unavailableEarnings: ["eps" as const] } : {}),
      currency: statement.currency,
    },
  };
}

function historicalValuation(
  financials: TickerFinancials,
  statement: FinancialStatement,
  metric: string,
  currencies: ValuationCurrencyContext,
) {
  // A price failure cannot make absent financial inputs appear available.
  if (currencies.priceInStatementUnits(statement, 1) === null || valuationAtPrice(statement, metric, 1) === null) return null;
  const priceDate = metricAvailability(statement, metric) ?? statement.date;
  const price = valuationPriceAtOrBefore(financials.priceHistory, priceDate);
  if (!price) return null;
  const comparablePrice = price.price === null ? null : currencies.priceInStatementUnits(statement, price.price);
  return { value: comparablePrice === null ? null : valuationAtPrice(statement, metric, comparablePrice), integrity: price.integrity, issue: price.issue };
}

function hasValuationInputs(statement: InternalStatement, metric: string): boolean {
  if (metric === "trailingPE") {
    return hasStatementGap(statement, "eps") || statement.epsBasis?.status === "unresolved"
      || statement.__timeSeriesIncompleteCommonIncome === true
      || statement.__timeSeriesIncompleteAverageShares === true
      || selectedEps(statement) !== null;
  }
  if (!selectedShares(statement)) return false;
  if (metric === "priceSales") return isFiniteNumber(statement.totalRevenue);
  if (metric === "priceFcf") return freeCashFlow(statement).value !== null;
  if (!isFiniteNumber(statement.totalDebt) || !selectedCash(statement)) return false;
  return metric === "evSales" ? isFiniteNumber(statement.totalRevenue)
    : metric === "evEbitda" && isFiniteNumber(statement.ebitda);
}

function valuationAtPrice(
  statement: FinancialStatement,
  metric: string,
  price: number,
): number | null {
  const shares = selectedShares(statement);
  const marketCap = shares ? price * shares.value : null;
  const cash = selectedCash(statement)?.value;
  const debt = statement.totalDebt;
  // Unknown balance-sheet inputs are not zero balances. Avoid manufacturing
  // an EV multiple from market capitalization alone when coverage is sparse.
  const enterpriseValue = marketCap !== null && isFiniteNumber(debt) && isFiniteNumber(cash)
    ? marketCap + debt - cash
    : null;
  if (metric === "trailingPE") {
    const eps = selectedEps(statement)?.value;
    return eps && eps > 0 ? price / eps : null;
  }
  if (metric === "priceSales") return ratio(marketCap, statement.totalRevenue);
  if (metric === "evSales") return ratio(enterpriseValue, statement.totalRevenue);
  if (metric === "evEbitda") return ratio(enterpriseValue, statement.ebitda);
  if (metric === "priceFcf") return ratio(marketCap, freeCashFlow(statement).value);
  return null;
}

function providerCurrentValuationPoint(
  financials: TickerFinancials,
  metric: string,
): TimeSeriesPoint | null {
  const value = metric === "forwardPE"
    ? financials.fundamentals?.forwardPE
    : metric === "pegRatio"
      ? financials.fundamentals?.pegRatio
      : undefined;
  if (!isFiniteNumber(value) || (metric === "forwardPE" && value <= 0)) return null;
  const quoteTime = financials.quote?.lastUpdated;
  const date = validDate(isFiniteNumber(quoteTime) && quoteTime > 0 ? quoteTime : null);
  if (!date) return null;
  return {
    date,
    observedAt: date,
    availableAt: date,
    value,
    periodLabel: "Current",
    provenance: {
      providerId: financials.quote?.providerId,
      quality: "estimated",
    },
  };
}

function currentDerivedValuationPoint(
  financials: TickerFinancials,
  statements: readonly FinancialStatement[],
  metric: string,
  currencies: ValuationCurrencyContext,
): TimeSeriesPoint | null {
  const quote = financials.quote;
  if (valuationQuoteIssue(quote)) return null;
  const quoteDate = validDate(quote?.lastUpdated);
  if (!quoteDate || !isFiniteNumber(quote?.price) || quote.price <= 0) return null;
  const quoteTime = quoteDate.getTime();
  // Select the latest known period first. Missing inputs, a loss or incompatible
  // currency cannot make an older period's denominator current again.
  const statement = statements
    .flatMap((candidate) => {
      const availableAt = validDate(metricAvailability(candidate, metric) ?? candidate.date);
      const observedAt = validDate(candidate.date);
      if (!availableAt || !observedAt || availableAt.getTime() > quoteTime) return [];
      return [{ candidate, observedAt: observedAt.getTime(), availableAt: availableAt.getTime() }];
    })
    .sort((left, right) => (
      left.observedAt - right.observedAt || left.availableAt - right.availableAt
    ))
    .at(-1)?.candidate;
  if (!statement) return null;
  const comparablePrice = currencies.priceInStatementUnits(statement, quote.price);
  if (comparablePrice === null) return null;
  const value = valuationAtPrice(statement, metric, comparablePrice);
  if (value === null) return null;
  return {
    date: quoteDate,
    observedAt: quoteDate,
    availableAt: quoteDate,
    value,
    periodLabel: "Current",
    provenance: {
      providerId: quote.providerId,
      quality: "derived",
    },
  };
}

/** Whether a valuation field derives a current point from the latest quote. */
export function valuationSeriesUsesLiveQuote(fieldId: string): boolean {
  const [namespace, metric = ""] = canonicalTimeSeriesFieldId(fieldId).split(".");
  return namespace === "valuation" && (QUOTE_DERIVED_VALUATION_IDS.has(metric) || metric === "forwardPE");
}

/** Whether a valuation field needs the full price history to date its observations. */
export function valuationSeriesUsesPriceHistory(fieldId: string): boolean {
  const [namespace, metric = ""] = canonicalTimeSeriesFieldId(fieldId).split(".");
  return namespace === "valuation" && PRICE_HISTORY_VALUATION_IDS.has(metric);
}

function preferredPeriodPoint(
  existing: TimeSeriesPoint,
  candidate: TimeSeriesPoint,
): TimeSeriesPoint {
  if (existing.provenance?.quality !== candidate.provenance?.quality) {
    return candidate.provenance?.quality === "reported" ? candidate : existing;
  }
  const existingAvailableAt = existing.availableAt?.getTime();
  const candidateAvailableAt = candidate.availableAt?.getTime();
  const existingHasAvailability = Number.isFinite(existingAvailableAt);
  const candidateHasAvailability = Number.isFinite(candidateAvailableAt);
  if (existingHasAvailability !== candidateHasAvailability) {
    return candidateHasAvailability ? candidate : existing;
  }
  if (
    existingHasAvailability
    && candidateHasAvailability
    && candidateAvailableAt! !== existingAvailableAt!
  ) {
    const preferLater = !Object.is(existing.value, candidate.value);
    const candidateWins = preferLater
      ? candidateAvailableAt! > existingAvailableAt!
      : candidateAvailableAt! < existingAvailableAt!;
    return candidateWins ? candidate : existing;
  }
  return candidate.observedAt.getTime() < existing.observedAt.getTime()
    ? candidate
    : existing;
}

/**
 * Provider snapshots can contain both an issuer fiscal-period row and a
 * calendar-normalized row for the same observation. Their period ends and
 * display timestamps differ slightly, so timestamp-only deduplication renders
 * paired bars. A financial period is the observation identity; publication
 * time only decides when that observation became available.
 */
function dedupeFundamentalPeriods(points: readonly TimeSeriesPoint[]): TimeSeriesPoint[] {
  const groups: TimeSeriesPoint[][] = [];
  const sorted = [...points].sort((left, right) => (
    left.observedAt.getTime() - right.observedAt.getTime()
  ));
  for (const point of sorted) {
    const lastGroup = groups.at(-1);
    if (lastGroup && areNearbyFinancialPeriodEnds(lastGroup[0]!.observedAt, point.observedAt)
      && (lastGroup[0]!.observedAt.getTime() === point.observedAt.getTime()
        || ![point, ...lastGroup].some(item => item.provenance?.unavailableEarnings?.length))) {
      lastGroup.push(point);
    } else groups.push([point]);
  }
  return groups
    .map((group) => group.slice(1).reduce(preferredPeriodPoint, group[0]!))
    .sort((left, right) => (
      left.date.getTime() - right.date.getTime()
      || left.observedAt.getTime() - right.observedAt.getTime()
    ));
}

/** Extracts the selected statement snapshot, retaining known availability dates without reconstructing prior vintages. */
export function extractFundamentalSeries(
  financials: TickerFinancials | null,
  source: SecuritySeriesSource,
): TimeSeriesPoint[] {
  if (!financials) return [];
  const canonicalId = canonicalTimeSeriesFieldId(source.fieldId);
  const [namespace, metric = ""] = canonicalId.split(".");
  if (namespace === "fundamental" && FUNDAMENTAL_IDS.has(metric)) {
    const selected = sourceStatements(financials, source.period);
    let hasObservation = false;
    const points = selected.statements.flatMap((statement) => {
      const result = fundamentalValue(statement, metric);
      if (result.value !== null) hasObservation = true;
      const point = pointForStatement(
        statement,
        metric,
        result.value,
        selected.period,
        source.timestampMode,
        result.derived,
      );
      return point ? [point] : [];
    });
    if (!hasObservation) return [];
    const deduped = dedupeFundamentalPeriods(points);
    return getTimeSeriesField(canonicalId)?.unit.startsWith("currency")
      ? reportingCurrencySeries(deduped, financials.financialCurrency).points : deduped;
  }

  if (namespace !== "valuation" || !VALUATION_IDS.has(metric)) return [];
  if (metric === "forwardPE") {
    const points = forwardPeHistory(financials, createValuationCurrencyContext(financials));
    if (points.length > 0) return points;
    // Without an estimate history the provider's own figure is all there is.
    const current = providerCurrentValuationPoint(financials, metric);
    return current ? [current] : [];
  }
  if (metric === "realizedNtmPE") {
    return realizedNtmPeHistory(financials, createValuationCurrencyContext(financials));
  }
  if (metric === "pegRatio") {
    const current = providerCurrentValuationPoint(financials, metric);
    return current ? [current] : [];
  }

  const selected = sourceStatements(financials, source.period, metric);
  const currencies = createValuationCurrencyContext(financials);
  let hasHistoricalObservation = false;
  const historical = selected.statements.flatMap((statement) => {
    const historical = historicalValuation(financials, statement, metric, currencies);
    if (historical !== null) hasHistoricalObservation = true;
    const point = pointForStatement(
      statement,
      metric,
      historical?.value ?? null,
      selected.period,
      source.timestampMode,
      true,
    );
    if (point && historical?.integrity) point.provenance = { ...point.provenance, priceHistoryIntegrity: historical.integrity };
    if (point && historical?.issue) point.provenance = { ...point.provenance,
      valuationPriceIssues: [{ ...historical.issue, affectedAt: point.date.toISOString() }] };
    return point ? [point] : [];
  });
  const current = currentDerivedValuationPoint(financials, selected.statements, metric, currencies);
  if (!hasHistoricalObservation && !current) return [];
  const dedupedHistorical = dedupeFundamentalPeriods(historical);
  // Publication timestamps can be shared by distinct fiscal periods. Their
  // period identities were deduplicated above; a gap must not overwrite a
  // different period's usable observation released on the same date.
  return (current ? [...dedupedHistorical, current] : dedupedHistorical).sort((left, right) => (
    left.date.getTime() - right.date.getTime() || left.observedAt.getTime() - right.observedAt.getTime()
  ));
}

export function fundamentalSeriesUsesAvailabilityFallback(
  financials: TickerFinancials | null,
  source: SecuritySeriesSource,
): boolean {
  if (!financials || source.timestampMode === "period-end") return false;
  const points = extractFundamentalSeries(financials, source);
  return points.some((point) => point.availableAt === undefined);
}

/** Explains withheld currency-dependent values through chart and export metadata. */
export function valuationCurrencyWarning(financials: TickerFinancials, source: SecuritySeriesSource): string | undefined {
  const [namespace, metric = ""] = canonicalTimeSeriesFieldId(source.fieldId).split(".");
  if (namespace !== "valuation" || !QUOTE_DERIVED_VALUATION_IDS.has(metric)) return undefined;
  const selected = sourceStatements(financials, source.period, metric);
  return createValuationCurrencyContext(financials).warning(selected.statements.filter((row) => (
    valuationAtPrice(row, metric, 1) !== null
  )));
}

/** Structured failures preserve source values independently of the chart's ratios. */
export function valuationPriceIssues(financials: TickerFinancials, source: SecuritySeriesSource): ValuationPriceIssue[] {
  if (!valuationSeriesUsesLiveQuote(source.fieldId)) return [];
  const metric = canonicalTimeSeriesFieldId(source.fieldId).split(".")[1]!;
  const currencies = createValuationCurrencyContext(financials);
  const selected = sourceStatements(financials, source.period, metric);
  const rows = selected.statements.filter((row) => (
    currencies.priceInStatementUnits(row, 1) !== null && valuationAtPrice(row, metric, 1) !== null
  ));
  if (!rows.length) return [];
  const quoteIssue = valuationQuoteIssue(financials.quote);
  const issues = rows.flatMap((row) => {
    const price = valuationPriceAtOrBefore(financials.priceHistory, metricAvailability(row, metric) ?? row.date);
    const date = pointForStatement(row, metric, null, selected.period, source.timestampMode, true)?.date;
    return price?.issue && date ? [{ ...price.issue, affectedAt: date.toISOString() }] : [];
  });
  return [...(quoteIssue ? [quoteIssue] : []), ...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
}
