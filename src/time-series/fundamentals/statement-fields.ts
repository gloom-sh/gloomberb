// Picks the statement fields a metric reads (shares, cash, EPS, free cash flow) and the dependencies that date it.
import type { FinancialStatement } from "../../types/financials";
import { completeAvailability, statementFieldAvailability } from "../../utils/financial-statements";
import { hasStatementGap } from "../../utils/statement-gaps";
import { isFiniteNumber } from "../../utils/guards";
import { rateValue, revenueMargin } from "../../utils/growth";
import { type InternalStatement, type NumericStatementField, statementNumber } from "./statement";

export function ratio(numerator: unknown, denominator: unknown): number | null {
  return isFiniteNumber(numerator) && isFiniteNumber(denominator) && denominator !== 0
    ? numerator / denominator
    : null;
}

/** A margin in percent: none over zero or negative revenue, where it is not meaningful. */
function revenuePercent(numerator: unknown, revenue: unknown): { value: number | null; derived: true } {
  const margin = isFiniteNumber(numerator) && isFiniteNumber(revenue) ? rateValue(revenueMargin(numerator, revenue)) : null;
  return { value: margin === null ? null : margin * 100, derived: true };
}

export function freeCashFlow(statement: FinancialStatement): { value: number | null; derived: boolean } {
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

export function selectedShares(statement: FinancialStatement): SelectedStatementField | null {
  return selectStatementField(
    statement,
    ["dilutedShares", "basicShares", "ordinarySharesNumber", "shareIssued"],
    (value) => value > 0,
  );
}

export function selectedCash(statement: FinancialStatement): SelectedStatementField | null {
  return selectStatementField(statement, [
    "cashCashEquivalentsAndShortTermInvestments",
    "cashAndCashEquivalents",
  ]);
}

export function selectedEps(
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

export function metricAvailability(statement: FinancialStatement, metric: string): string | undefined {
  const dependencies = metricDependencies(metric, statement);
  return completeAvailability(dependencies.map((field) => statementFieldAvailability(statement, field)));
}

export function fundamentalValue(
  statement: InternalStatement,
  metric: string,
): { value: number | null; derived: boolean } {
  if (metric === "grossMargin") return revenuePercent(statement.grossProfit, statement.totalRevenue);
  if (metric === "operatingMargin") return revenuePercent(statement.operatingIncome, statement.totalRevenue);
  if (metric === "netMargin") return revenuePercent(statement.netIncome, statement.totalRevenue);
  if (metric === "freeCashFlow" || metric === "freeCashFlowMargin") {
    const fcf = freeCashFlow(statement);
    if (metric === "freeCashFlow") return fcf;
    return revenuePercent(fcf.value, statement.totalRevenue);
  }
  const value = statementNumber(statement, metric as NumericStatementField);
  const derived = statement.__timeSeriesTtm === true
    || statement.__timeSeriesDerivedFields?.includes(metric as NumericStatementField) === true;
  return { value, derived };
}
