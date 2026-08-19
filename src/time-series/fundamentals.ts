import type {
  FinancialStatement,
  PricePoint,
  TickerFinancials,
} from "../types/financials";
import { areNearbyFinancialPeriodEnds } from "../utils/financial-statements";
import { canonicalTimeSeriesFieldId } from "./field-catalog";
import type { SecuritySeriesSource, SeriesPeriod, TimeSeriesPoint } from "./types";

type NumericStatementField =
  | "totalRevenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
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
};

const DAY_MS = 24 * 60 * 60 * 1_000;

export const QUARTERLY_FLOW_FIELDS: readonly NumericStatementField[] = [
  "totalRevenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "ebitda",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
  "eps",
];

export const QUARTERLY_SNAPSHOT_FIELDS: readonly NumericStatementField[] = [
  "totalAssets",
  "cashAndCashEquivalents",
  "cashCashEquivalentsAndShortTermInvestments",
  "totalDebt",
  "totalEquity",
  "basicShares",
  "dilutedShares",
  "shareIssued",
  "ordinarySharesNumber",
];

const NUMERIC_STATEMENT_FIELDS: readonly NumericStatementField[] = [
  ...QUARTERLY_FLOW_FIELDS,
  ...QUARTERLY_SNAPSHOT_FIELDS,
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
  "pegRatio",
  "priceSales",
  "evSales",
  "evEbitda",
  "priceFcf",
]);

const QUOTE_DERIVED_VALUATION_IDS = new Set([
  "trailingPE",
  "priceSales",
  "evSales",
  "evEbitda",
  "priceFcf",
]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function latestDateString(values: Array<string | null | undefined>): string | undefined {
  let latest: { value: string; time: number } | undefined;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (!latest || time > latest.time) latest = { value, time };
  }
  return latest?.value;
}

function statementTime(statement: FinancialStatement): number {
  return Date.parse(statement.date);
}

function statementNumber(statement: FinancialStatement, field: NumericStatementField): number | null {
  const value = statement[field];
  return finiteNumber(value) ? value : null;
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
  if (availableAt) {
    statement.fieldAvailability = { ...statement.fieldAvailability, [field]: availableAt };
  }
}

function periodCategory(date: string, period: "annual" | "quarterly"): string {
  const parsedYear = Number(date.slice(0, 4));
  let year = Number.isFinite(parsedYear) ? parsedYear : 0;
  if (period === "annual") return year > 0 ? `FY${year}` : date;

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
  const merged: InternalStatement = { date: dateSource.date };
  const derivedFields: NumericStatementField[] = [];
  const fieldAvailability: Record<string, string> = {};
  const record = merged as unknown as Record<string, unknown>;

  for (const field of NUMERIC_STATEMENT_FIELDS) {
    const candidates = statements.flatMap((statement): StatementFieldCandidate[] => {
      const value = statementNumber(statement, field);
      if (value === null) return [];
      return [{
        statement,
        value,
        availableAt: statement.fieldAvailability?.[field] ?? statement.availableAt,
        derived: statement.__timeSeriesDerivedFields?.includes(field) === true,
      }];
    });
    if (candidates.length === 0) continue;
    const selected = selectFieldCandidate(candidates);
    record[field] = selected.value;
    if (selected.availableAt) fieldAvailability[field] = selected.availableAt;
    if (selected.derived) derivedFields.push(field);
  }

  if (Object.keys(fieldAvailability).length > 0) {
    merged.fieldAvailability = fieldAvailability;
    merged.availableAt = latestDateString(Object.values(fieldAvailability));
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

  const annualCategory = periodCategory(annualStatement.date, "quarterly");
  const byCategory = new Map<string, PrecedingQuarterInput>();
  for (const statement of quarterlyStatements) {
    const time = statementTime(statement);
    if (!Number.isFinite(time) || time >= annualTime || annualTime - time > 370 * DAY_MS) continue;
    const category = periodCategory(statement.date, "quarterly");
    if (category === annualCategory) continue;
    const value = statementNumber(statement, field);
    if (value === null) continue;
    const previous = byCategory.get(category);
    if (!previous || statement.date.localeCompare(previous.date) > 0) {
      byCategory.set(category, {
        date: statement.date,
        time,
        value,
        availableAt: statement.fieldAvailability?.[field] ?? statement.availableAt,
      });
    }
  }

  return [...byCategory.values()]
    .sort((left, right) => right.time - left.time)
    .slice(0, 3)
    .sort((left, right) => left.time - right.time);
}

/**
 * Completes missing fiscal Q4 rows from the annual total and the three reported
 * quarters. Snapshot fields are copied from the annual balance sheet. Derived
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
    let target: InternalStatement = byDate.get(annualStatement.date) ?? { date: annualStatement.date };
    let changed = false;

    for (const field of QUARTERLY_FLOW_FIELDS) {
      if (statementNumber(target, field) !== null) continue;
      const annualValue = statementNumber(annualStatement, field);
      if (annualValue === null) continue;
      const previousInputs = precedingQuarterInputs(mergedQuarterly, annualStatement, field);
      if (previousInputs.length !== 3) continue;
      const derived = annualValue - previousInputs.reduce((sum, input) => sum + input.value, 0);
      if (!Number.isFinite(derived)) continue;
      const availableAt = latestDateString([
        annualStatement.fieldAvailability?.[field] ?? annualStatement.availableAt,
        ...previousInputs.map((input) => input.availableAt),
      ]);
      setStatementNumber(target, field, derived, availableAt);
      changed = true;
    }

    for (const field of QUARTERLY_SNAPSHOT_FIELDS) {
      if (statementNumber(target, field) !== null) continue;
      const annualValue = statementNumber(annualStatement, field);
      if (annualValue === null) continue;
      const availableAt = annualStatement.fieldAvailability?.[field] ?? annualStatement.availableAt;
      setStatementNumber(target, field, annualValue, availableAt);
      changed = true;
    }

    if (changed) {
      target.availableAt = latestDateString([
        target.availableAt,
        annualStatement.availableAt,
        ...Object.values(target.fieldAvailability ?? {}),
      ]);
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
    const firstTime = statementTime(window[0]!);
    const lastTime = statementTime(window.at(-1)!);
    if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime - firstTime > 400 * DAY_MS) {
      continue;
    }

    const latest = window.at(-1)!;
    const ttm: InternalStatement = {
      date: latest.date,
      availableAt: latestDateString(window.map((statement) => statement.availableAt)),
      fieldAvailability: {},
      __timeSeriesTtm: true,
      __timeSeriesDerivedFields: [],
    };

    for (const field of QUARTERLY_FLOW_FIELDS) {
      const values = window.map((statement) => statementNumber(statement, field));
      if (!values.every((value): value is number => value !== null)) continue;
      (ttm as unknown as Record<string, unknown>)[field] = values.reduce((sum, value) => sum + value, 0);
      ttm.__timeSeriesDerivedFields!.push(field);
      const availableAt = latestDateString(window.map((statement) => (
        statement.fieldAvailability?.[field] ?? statement.availableAt
      )));
      if (availableAt) ttm.fieldAvailability![field] = availableAt;
    }

    for (const field of QUARTERLY_SNAPSHOT_FIELDS) {
      const value = statementNumber(latest, field);
      if (value === null) continue;
      (ttm as unknown as Record<string, unknown>)[field] = value;
      const availableAt = latest.fieldAvailability?.[field] ?? latest.availableAt;
      if (availableAt) ttm.fieldAvailability![field] = availableAt;
    }
    ttm.availableAt = latestDateString([
      ttm.availableAt,
      ...Object.values(ttm.fieldAvailability ?? {}),
    ]);
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
    if (valuationMetric && ttm.some((statement) => (
      valuationAtPrice(statement, valuationMetric, 1) !== null
    ))) {
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
  return finiteNumber(numerator) && finiteNumber(denominator) && denominator !== 0
    ? numerator / denominator
    : null;
}

function freeCashFlow(statement: FinancialStatement): { value: number | null; derived: boolean } {
  if (finiteNumber(statement.freeCashFlow)) return { value: statement.freeCashFlow, derived: false };
  if (finiteNumber(statement.operatingCashFlow) && finiteNumber(statement.capitalExpenditure)) {
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
  statement: FinancialStatement,
): { value: number; dependencies: NumericStatementField[] } | null {
  if (finiteNumber(statement.eps) && statement.eps !== 0) {
    return { value: statement.eps, dependencies: ["eps"] };
  }
  const shares = selectedShares(statement);
  if (!shares || !finiteNumber(statement.netIncome)) return null;
  return {
    value: statement.netIncome / shares.value,
    dependencies: ["netIncome", shares.field],
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
    return finiteNumber(statement.freeCashFlow)
      ? ["freeCashFlow", "totalRevenue"]
      : ["operatingCashFlow", "capitalExpenditure", "totalRevenue"];
  }
  if (metric === "freeCashFlow") {
    return finiteNumber(statement.freeCashFlow)
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
      finiteNumber(statement.totalDebt) ? "totalDebt" : undefined,
      selectedCash(statement)?.field,
    ]);
  }
  if (metric === "evEbitda") {
    return uniqueDependencies([
      "ebitda",
      selectedShares(statement)?.field,
      finiteNumber(statement.totalDebt) ? "totalDebt" : undefined,
      selectedCash(statement)?.field,
    ]);
  }
  if (metric === "priceFcf") {
    return uniqueDependencies([
      ...(finiteNumber(statement.freeCashFlow)
        ? ["freeCashFlow" as const]
        : ["operatingCashFlow" as const, "capitalExpenditure" as const]),
      selectedShares(statement)?.field,
    ]);
  }
  return [metric as NumericStatementField];
}

function metricAvailability(statement: FinancialStatement, metric: string): string | undefined {
  const dependencies = metricDependencies(metric, statement);
  if (dependencies.length === 0) return statement.availableAt;
  return latestDateString(dependencies.map((field) => (
    latestDateString([statement.fieldAvailability?.[field]]) ?? statement.availableAt
  )));
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
  value: number,
  period: "annual" | "quarterly" | "ttm",
  timestampMode: SecuritySeriesSource["timestampMode"],
  derived: boolean,
): TimeSeriesPoint | null {
  const observedAt = validDate(statement.date);
  if (!observedAt) return null;
  const availableAtString = metricAvailability(statement, metric);
  const availableAt = validDate(availableAtString);
  const date = timestampMode !== "period-end" && availableAt ? availableAt : observedAt;
  return {
    date,
    observedAt,
    availableAt: availableAt ?? undefined,
    value,
    periodLabel: period === "annual"
      ? periodCategory(statement.date, "annual")
      : period === "ttm"
        ? `TTM ${periodCategory(statement.date, "quarterly")}`
        : periodCategory(statement.date, "quarterly"),
    provenance: { quality: derived ? "derived" : "reported" },
  };
}

/**
 * `PricePoint.date` is typed as a `Date`, but history that has crossed a JSON
 * boundary (persisted caches, the screenshot payload) arrives as a string. Read
 * it defensively so a serialized round trip cannot crash valuation history.
 */
function pointTime(point: PricePoint): number {
  const date = point.date;
  return date instanceof Date ? date.getTime() : Date.parse(date as unknown as string);
}

function priceAtOrBefore(priceHistory: readonly PricePoint[], date: string): number | null {
  const target = Date.parse(date);
  if (!Number.isFinite(target)) return null;
  let closest: { time: number; close: number } | undefined;
  for (const point of priceHistory) {
    const time = pointTime(point);
    if (!Number.isFinite(time) || time > target || !finiteNumber(point.close) || point.close <= 0) continue;
    if (!closest || time > closest.time) closest = { time, close: point.close };
  }
  return closest?.close ?? null;
}

function historicalValuation(
  financials: TickerFinancials,
  statement: FinancialStatement,
  metric: string,
): number | null {
  const priceDate = metricAvailability(statement, metric) ?? statement.date;
  const price = priceAtOrBefore(financials.priceHistory, priceDate);
  return price === null ? null : valuationAtPrice(statement, metric, price);
}

function valuationAtPrice(
  statement: FinancialStatement,
  metric: string,
  price: number,
): number | null {
  const shares = selectedShares(statement);
  const marketCap = shares ? price * shares.value : null;
  const cash = selectedCash(statement)?.value ?? 0;
  const debt = finiteNumber(statement.totalDebt) ? statement.totalDebt : 0;
  const enterpriseValue = marketCap !== null
    ? marketCap + debt - (finiteNumber(cash) ? cash : 0)
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
  if (!finiteNumber(value)) return null;
  const quoteTime = financials.quote?.lastUpdated;
  const date = validDate(finiteNumber(quoteTime) && quoteTime > 0 ? quoteTime : null);
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
): TimeSeriesPoint | null {
  const quote = financials.quote;
  const quoteDate = validDate(quote?.lastUpdated);
  if (!quoteDate || !finiteNumber(quote?.price) || quote.price <= 0) return null;
  const quoteTime = quoteDate.getTime();
  const statement = statements
    .flatMap((candidate) => {
      const availableAt = validDate(metricAvailability(candidate, metric) ?? candidate.date);
      const observedAt = validDate(candidate.date);
      if (!availableAt || !observedAt || availableAt.getTime() > quoteTime) return [];
      if (valuationAtPrice(candidate, metric, quote.price) === null) return [];
      return [{ candidate, observedAt: observedAt.getTime(), availableAt: availableAt.getTime() }];
    })
    .sort((left, right) => (
      left.observedAt - right.observedAt || left.availableAt - right.availableAt
    ))
    .at(-1)?.candidate;
  if (!statement) return null;
  const value = valuationAtPrice(statement, metric, quote.price);
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
  return namespace === "valuation" && QUOTE_DERIVED_VALUATION_IDS.has(metric);
}

function dedupeAndSortPoints(points: readonly TimeSeriesPoint[]): TimeSeriesPoint[] {
  const byTimestamp = new Map<number, TimeSeriesPoint>();
  for (const point of points) {
    const time = point.date.getTime();
    if (Number.isFinite(time)) byTimestamp.set(time, point);
  }
  return [...byTimestamp.values()].sort((left, right) => left.date.getTime() - right.date.getTime());
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
    if (lastGroup && areNearbyFinancialPeriodEnds(lastGroup[0]!.observedAt, point.observedAt)) {
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

/** Extracts a point-in-time-safe fundamental or valuation series from a snapshot. */
export function extractFundamentalSeries(
  financials: TickerFinancials | null,
  source: SecuritySeriesSource,
): TimeSeriesPoint[] {
  if (!financials) return [];
  const canonicalId = canonicalTimeSeriesFieldId(source.fieldId);
  const [namespace, metric = ""] = canonicalId.split(".");
  if (namespace === "fundamental" && FUNDAMENTAL_IDS.has(metric)) {
    const selected = sourceStatements(financials, source.period);
    const points = selected.statements.flatMap((statement) => {
      const result = fundamentalValue(statement, metric);
      if (result.value === null) return [];
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
    return dedupeFundamentalPeriods(points);
  }

  if (namespace !== "valuation" || !VALUATION_IDS.has(metric)) return [];
  if (metric === "forwardPE" || metric === "pegRatio") {
    const current = providerCurrentValuationPoint(financials, metric);
    return current ? [current] : [];
  }

  const selected = sourceStatements(financials, source.period, metric);
  const historical = selected.statements.flatMap((statement) => {
    const value = historicalValuation(financials, statement, metric);
    if (value === null) return [];
    const point = pointForStatement(
      statement,
      metric,
      value,
      selected.period,
      source.timestampMode,
      true,
    );
    return point ? [point] : [];
  });
  const current = currentDerivedValuationPoint(financials, selected.statements, metric);
  const dedupedHistorical = dedupeFundamentalPeriods(historical);
  return dedupeAndSortPoints(current ? [...dedupedHistorical, current] : dedupedHistorical);
}

export function fundamentalSeriesUsesAvailabilityFallback(
  financials: TickerFinancials | null,
  source: SecuritySeriesSource,
): boolean {
  if (!financials || source.timestampMode === "period-end") return false;
  const points = extractFundamentalSeries(financials, source);
  return points.some((point) => point.availableAt === undefined);
}
