// Statement field names, the numeric field lists and the accessors every fundamentals module reads a statement through.
import type { FinancialStatement } from "../../types/financials";
import { completeAvailability, statementFieldAvailability } from "../../utils/financial-statements";
import { isFiniteNumber } from "../../utils/guards";

export type NumericStatementField =
  | "totalRevenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "netIncomeIncludingNoncontrollingInterests"
  | "netIncomeCommonStockholders"
  | "ebitda"
  | "depreciationAndAmortization"
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

export type InternalStatement = FinancialStatement & {
  __timeSeriesDerivedFields?: NumericStatementField[];
  __timeSeriesTtm?: boolean;
  __timeSeriesIncompleteCommonIncome?: boolean;
  __timeSeriesIncompleteAverageShares?: boolean;
};

export const DAY_MS = 24 * 60 * 60 * 1_000;

export const QUARTERLY_FLOW_FIELDS: readonly NumericStatementField[] = [
  "totalRevenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "netIncomeIncludingNoncontrollingInterests",
  "ebitda",
  "depreciationAndAmortization",
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

export const QUARTERLY_AVERAGE_FIELDS: readonly NumericStatementField[] = ["basicShares", "dilutedShares"];

// Reported common-income allocations and EPS may be summed for TTM, but
// independently determined annual values cannot establish a missing quarter.
// A trailing year across a fiscal Q4 without EPS reads that year's own EPS.
export const TTM_SUM_FIELDS: readonly NumericStatementField[] = [...QUARTERLY_FLOW_FIELDS, "netIncomeCommonStockholders", "eps"];

export const NUMERIC_STATEMENT_FIELDS: readonly NumericStatementField[] = [
  ...QUARTERLY_FLOW_FIELDS,
  ...QUARTERLY_SNAPSHOT_FIELDS,
  ...QUARTERLY_AVERAGE_FIELDS,
  "netIncomeCommonStockholders",
  "eps",
];

export function validDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function statementTime(statement: FinancialStatement): number {
  return Date.parse(statement.date);
}

export function statementNumber(statement: FinancialStatement, field: NumericStatementField): number | null {
  if (field === "eps" && statement.epsBasis?.status === "unresolved") return null;
  const value = statement[field];
  return isFiniteNumber(value) ? value : null;
}

export function setStatementNumber(
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

export function completeStatementAvailability(statement: InternalStatement): string | undefined {
  return completeAvailability(NUMERIC_STATEMENT_FIELDS
    .filter((field) => statementNumber(statement, field) !== null)
    .map((field) => statementFieldAvailability(statement, field)));
}
