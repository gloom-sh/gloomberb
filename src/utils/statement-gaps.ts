import type { EarningsField, FinancialStatement, StatementGapField } from "../types/financials";
import { isIncomeStatementField } from "./income-statement";

/**
 * Lines outside net income that a source can declare unavailable for a period.
 * Net income lines use the same `unavailableFields` list but keep their own
 * per-field owners (see income-statement.ts).
 */
const STATEMENT_GAP_FIELDS = ["totalRevenue", "operatingRevenue", "pretaxIncome", "taxProvision"] as const satisfies readonly StatementGapField[];
const EARNINGS_FIELDS = ["basicEps", "eps"] as const satisfies readonly EarningsField[];

type GapField = StatementGapField | EarningsField;

function isEarningsField(field: string): field is EarningsField {
  return (EARNINGS_FIELDS as readonly string[]).includes(field);
}

/** Whether the row declares this line unavailable for its period. */
export function hasStatementGap(row: FinancialStatement | undefined, field: string): boolean {
  if (!row) return false;
  return isEarningsField(field)
    ? Array.isArray(row.unavailableEarnings) && row.unavailableEarnings.includes(field)
    : Array.isArray(row.unavailableFields) && (row.unavailableFields as string[]).includes(field);
}

/** Whether the row declares a gap in a line other than the net income lines. */
export function hasNonIncomeStatementGap(row: FinancialStatement | undefined): boolean {
  return [...STATEMENT_GAP_FIELDS, ...EARNINGS_FIELDS].some((field) => hasStatementGap(row, field));
}

function removeValue(row: FinancialStatement, field: GapField): void {
  delete row[field];
  if (row.fieldAvailability && field in row.fieldAvailability) {
    row.fieldAvailability = { ...row.fieldAvailability };
    delete row.fieldAvailability[field];
  }
}

/** A copy of the row with these lines declared unavailable and their values removed. */
export function withStatementGaps<T extends FinancialStatement>(row: T, fields: readonly GapField[]): T {
  if (fields.length === 0) return row;
  const result = { ...row };
  for (const field of fields) {
    removeValue(result, field);
    if (isEarningsField(field)) result.unavailableEarnings = [...new Set([...(result.unavailableEarnings ?? []), field])];
    else result.unavailableFields = [...new Set([...(result.unavailableFields ?? []), field])];
  }
  return result;
}

/**
 * Carry declared gaps into a row merged from these inputs. A gap any input
 * declares wins over another input's value, so neither a vendor figure nor a
 * chart residual can fill it. Net income entries already on the target stay
 * as their owner merge left them.
 */
export function mergeStatementGaps(target: FinancialStatement, rows: readonly (FinancialStatement | undefined)[]): void {
  const lines = STATEMENT_GAP_FIELDS.filter((field) => rows.some((row) => hasStatementGap(row, field)));
  const earnings = EARNINGS_FIELDS.filter((field) => rows.some((row) => hasStatementGap(row, field)));
  const income = (Array.isArray(target.unavailableFields) ? target.unavailableFields : []).filter(isIncomeStatementField);
  const unavailableFields = [...income, ...lines];
  if (unavailableFields.length) target.unavailableFields = unavailableFields;
  else delete target.unavailableFields;
  if (earnings.length) target.unavailableEarnings = earnings;
  else delete target.unavailableEarnings;
  for (const field of [...lines, ...earnings]) removeValue(target, field);
}

// Gloom Cloud strips a withdrawn value and names it with an id on the row,
// such as "…-2025q4-revenue". The suffix names the line; the row is the period.
// This bridge goes away once the payload lists the lines in `unavailableFields`
// and `unavailableEarnings` itself.
const WITHDRAWN_LINE_SUFFIXES: ReadonlyArray<readonly [string, GapField]> = [
  ["-operating-revenue", "operatingRevenue"],
  ["-revenue", "totalRevenue"],
  ["-parent-income", "netIncome"],
  ["-common-income", "netIncomeCommonStockholders"],
  ["-pretax", "pretaxIncome"],
  ["-tax", "taxProvision"],
  ["-basicEps", "basicEps"],
  ["-eps", "eps"],
];

/** Read a row's Cloud withdrawal ids as declared gaps and drop the ids. */
export function readWithdrawnObservations<T extends FinancialStatement>(row: T): T {
  if (row.withdrawnObservations === undefined) return row;
  const ids = Array.isArray(row.withdrawnObservations) ? row.withdrawnObservations : [];
  const fields = ids.flatMap((id) => {
    const line = typeof id === "string" ? WITHDRAWN_LINE_SUFFIXES.find(([suffix]) => id.endsWith(suffix)) : undefined;
    return line ? [line[1]] : [];
  });
  const { withdrawnObservations: _ids, ...rest } = row;
  return withStatementGaps(rest as T, fields);
}
