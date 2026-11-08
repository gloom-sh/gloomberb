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

/** Operating income, and how it was read when the row does not report it: the lines it was derived from. */
interface OperatingIncome {
  value: number;
  /** Null where the row reports operating income; else what it was derived as ("pretax income + interest expense - other income"). */
  basis: string | null;
  fields: readonly (keyof FinancialStatement)[];
}

/**
 * The row's operating income: the reported line, or, where a row lacks it (an
 * energy major's quarter filed without one), derived from the lines it
 * carries: revenue less total expenses, revenue less cost of revenue and
 * operating expenses, else pretax income (or net income with its income tax
 * added back) with interest expense added back and non-operating items taken
 * out, as far as the row carries them. On Exxon Mobil's 2025 year each gives
 * the 33.94B it reported.
 */
function operatingIncome(row: FinancialStatement, derive: boolean): OperatingIncome | null {
  if (finite(row.operatingIncome)) return { value: row.operatingIncome, basis: null, fields: ["operatingIncome"] };
  if (!derive) return null;
  if (finite(row.totalRevenue) && finite(row.totalExpenses)) {
    return { value: row.totalRevenue - row.totalExpenses, basis: "revenue less total expenses", fields: ["totalRevenue", "totalExpenses"] };
  }
  if (finite(row.totalRevenue) && finite(row.costOfRevenue) && finite(row.operatingExpense)) {
    return {
      value: row.totalRevenue - row.costOfRevenue - row.operatingExpense,
      basis: "revenue less cost of revenue and operating expenses",
      fields: ["totalRevenue", "costOfRevenue", "operatingExpense"],
    };
  }
  const pretax = pretaxIncome(row);
  if (!pretax) return null;
  const interest = finite(row.interestExpense) ? Math.abs(row.interestExpense) : null;
  // Other income and expense is every non-operating line together; the other non-operating line alone is part of it.
  const nonOperating = finite(row.otherIncomeExpense) ? { value: row.otherIncomeExpense, field: "otherIncomeExpense" as const }
    : finite(row.otherNonOperatingIncomeExpenses) ? { value: row.otherNonOperatingIncomeExpenses, field: "otherNonOperatingIncomeExpenses" as const }
      : null;
  return {
    value: pretax.value + (interest ?? 0) - (nonOperating?.value ?? 0),
    basis: [pretax.basis, ...interest !== null ? ["+ interest expense"] : [], ...nonOperating ? ["- non-operating items"] : []].join(" "),
    fields: [...pretax.fields, ...interest !== null ? ["interestExpense" as const] : [], ...nonOperating ? [nonOperating.field] : []],
  };
}

/** Pretax income as reported, or as net income (with minority interests) plus its income tax (Chevron's quarters file no pretax line). */
function pretaxIncome(row: FinancialStatement): { value: number; basis: string; fields: readonly (keyof FinancialStatement)[] } | null {
  if (finite(row.pretaxIncome)) return { value: row.pretaxIncome, basis: "pretax income", fields: ["pretaxIncome"] };
  if (!finite(row.taxProvision)) return null;
  const income = finite(row.netIncomeIncludingNoncontrollingInterests) ? "netIncomeIncludingNoncontrollingInterests" as const
    : finite(row.netIncome) ? "netIncome" as const : null;
  return income ? { value: row[income]! + row.taxProvision, basis: "net income + income tax", fields: [income, "taxProvision"] } : null;
}

/**
 * Whether a company's statements carry no EBITDA that means anything: a bank's
 * or an insurer's interest and claims are its operations, so operating income
 * is not derived for it and an EV over its EBITDA reads N/M.
 */
export function isBankOrInsurerIndustry(industry: string | null | undefined): boolean {
  return /\b(banks?|insurance|insurers?|reinsurance)\b/i.test(industry ?? "");
}

/** What an EV/EBITDA reads for a bank or an insurer (isBankOrInsurerIndustry). */
export const BANK_OR_INSURER_EBITDA = "not meaningful for banks and insurers";

/**
 * EBITDA as the glossary defines it and sell-side comps read it: operating
 * income with D&A added back. Null when the row lacks either; a source's own
 * EBITDA line can carry non-operating income and is never used in its place.
 */
function statementEbitda(row: FinancialStatement, derive: boolean): { value: number; income: OperatingIncome; amortization: { value: number; field: DepreciationField } } | null {
  const amortization = depreciation(row);
  const income = operatingIncome(row, derive);
  return income && amortization ? { value: income.value + amortization.value, income, amortization } : null;
}

/** Whether the row's EBITDA is missing for want of D&A beside a reported operating income, which a cell says. */
export function ebitdaLacksDepreciation(row: FinancialStatement | null | undefined): boolean {
  return !!row && !finite(row.ebitda) && finite(row.operatingIncome) && !depreciation(row);
}

/**
 * How the row's EBITDA read its operating income where the row reports none:
 * `pretax income + interest expense - non-operating items`. Null where it was
 * reported, or where the row has no EBITDA.
 */
export function ebitdaOperatingIncomeBasis(row: FinancialStatement | null | undefined): string | null {
  if (!row || !finite(row.ebitda) || finite(row.operatingIncome)) return null;
  return operatingIncome(row, true)?.basis ?? null;
}

/**
 * The row with `ebitda` on that definition, dated by the later of its inputs:
 * the source's figure is dropped, and a row without D&A has none. `derive`
 * false (a bank's or an insurer's rows) reads reported operating income alone.
 */
export function withStatementEbitda<T extends FinancialStatement>(row: T, derive = true): T {
  const ebitda = statementEbitda(row, derive);
  const value = ebitda?.value ?? null;
  const availableAt = ebitda
    ? completeAvailability([...ebitda.income.fields, ebitda.amortization.field].map((field) => statementFieldAvailability(row, field)))
    : undefined;
  if (row.ebitda === (value ?? undefined) && (!row.fieldAvailability || row.fieldAvailability.ebitda === availableAt)) return row;
  const { ebitda: _source, ...rest } = row;
  const next = (value === null ? rest : { ...rest, ebitda: value }) as T;
  if (row.fieldAvailability) {
    const { ebitda: _dated, ...fieldAvailability } = row.fieldAvailability;
    next.fieldAvailability = availableAt ? { ...fieldAvailability, ebitda: availableAt } : fieldAvailability;
  }
  return next;
}
