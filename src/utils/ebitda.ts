import type { FinancialStatement } from "../types/financials";
import { completeAvailability, statementFieldAvailability } from "./financial-statements";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

type DepreciationField = "depreciationAndAmortization" | "depreciationAmortizationDepletion";

/** The row's D&A: the cash flow statement's line, or D&A with depletion where only that is reported. */
function depreciation(row: FinancialStatement): { value: number; field: DepreciationField } | null {
  for (const field of ["depreciationAndAmortization", "depreciationAmortizationDepletion"] as const) {
    const value = row[field];
    // An add-back: some sources sign it as the cash flow line, others as the expense.
    if (finite(value)) return { value: Math.abs(value), field };
  }
  return null;
}

/**
 * EBITDA as the glossary defines it and sell-side comps read it: operating
 * income with D&A added back. Null when the row lacks either; a source's own
 * EBITDA line can carry non-operating income and is never used in its place.
 */
function statementEbitda(row: FinancialStatement): number | null {
  const amortization = depreciation(row);
  return finite(row.operatingIncome) && amortization ? row.operatingIncome + amortization.value : null;
}

/** Whether the row's EBITDA is missing for want of D&A beside a reported operating income, which a cell says. */
export function ebitdaLacksDepreciation(row: FinancialStatement | null | undefined): boolean {
  return !!row && !finite(row.ebitda) && finite(row.operatingIncome) && !depreciation(row);
}

/**
 * The row with `ebitda` on that definition, dated by the later of its two
 * inputs: the source's figure is dropped, and a row without D&A has none.
 */
export function withStatementEbitda<T extends FinancialStatement>(row: T): T {
  const value = statementEbitda(row);
  const amortization = depreciation(row);
  const availableAt = value === null || !amortization ? undefined
    : completeAvailability([statementFieldAvailability(row, "operatingIncome"), statementFieldAvailability(row, amortization.field)]);
  if (row.ebitda === (value ?? undefined) && (!row.fieldAvailability || row.fieldAvailability.ebitda === availableAt)) return row;
  const { ebitda: _source, ...rest } = row;
  const next = (value === null ? rest : { ...rest, ebitda: value }) as T;
  if (row.fieldAvailability) {
    const { ebitda: _dated, ...fieldAvailability } = row.fieldAvailability;
    next.fieldAvailability = availableAt ? { ...fieldAvailability, ebitda: availableAt } : fieldAvailability;
  }
  return next;
}
