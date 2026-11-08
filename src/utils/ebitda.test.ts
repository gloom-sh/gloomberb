import { expect, test } from "bun:test";
import type { FinancialStatement } from "../types/financials";
import { ebitdaOperatingIncomeBasis, withStatementEbitda } from "./ebitda";

// Exxon Mobil's 2025 year as served: operating income 33.938B, D&A with depletion 25.993B.
const XOM_2025: FinancialStatement = {
  date: "2025-12-31", currency: "USD", operatingIncome: 33_938e6, totalRevenue: 323_905e6, totalExpenses: 289_967e6,
  costOfRevenue: 252_665e6, operatingExpense: 37_302e6, pretaxIncome: 41_268e6, interestExpense: 603e6, otherIncomeExpense: 7_933e6,
  taxProvision: 11_504e6, netIncomeIncludingNoncontrollingInterests: 29_764e6, depreciationAmortizationDepletion: 25_993e6, ebitda: 59_931e6,
};

/** The year without its operating income and the given lines. */
function withoutLines(...lines: (keyof FinancialStatement)[]): FinancialStatement {
  return Object.fromEntries(Object.entries(XOM_2025).filter(([key]) => !["operatingIncome", ...lines].includes(key))) as FinancialStatement;
}

test("a row without operating income derives it from the lines it carries, each basis giving the reported figure, and says how", () => {
  expect(withStatementEbitda(XOM_2025).ebitda).toBe(59_931e6);
  expect(ebitdaOperatingIncomeBasis(withStatementEbitda(XOM_2025))).toBeNull();
  for (const [row, basis] of [
    [withoutLines(), "revenue less total expenses"],
    [withoutLines("totalExpenses"), "revenue less cost of revenue and operating expenses"],
    [withoutLines("totalExpenses", "operatingExpense"), "pretax income + interest expense - non-operating items"],
    [withoutLines("totalExpenses", "operatingExpense", "pretaxIncome"), "net income + income tax + interest expense - non-operating items"],
  ] as const) {
    const derived = withStatementEbitda(row);
    expect(derived.ebitda).toBeCloseTo(59_931e6, -3);
    expect(ebitdaOperatingIncomeBasis(derived)).toBe(basis);
  }
  // With only pretax income, it is pretax income: non-operating income stays in, and the basis says so.
  const pretaxOnly = withoutLines("totalExpenses", "operatingExpense", "interestExpense", "otherIncomeExpense");
  expect(withStatementEbitda(pretaxOnly).ebitda).toBe(41_268e6 + 25_993e6);
  expect(ebitdaOperatingIncomeBasis(withStatementEbitda(pretaxOnly))).toBe("pretax income");
  // A bank's or an insurer's rows read reported operating income alone.
  expect(withStatementEbitda(withoutLines(), false).ebitda).toBeUndefined();
});
