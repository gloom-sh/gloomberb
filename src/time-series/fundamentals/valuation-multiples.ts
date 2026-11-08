// Prices a statement-based multiple at a given price, and says whether a statement has the inputs for one.
import type { FinancialStatement } from "../../types/financials";
import { hasStatementGap } from "../../utils/statement-gaps";
import { isFiniteNumber } from "../../utils/guards";
import type { InternalStatement } from "./statement";
import { freeCashFlow, ratio, selectedCash, selectedEps, selectedShares } from "./statement-fields";

export function hasValuationInputs(statement: InternalStatement, metric: string): boolean {
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

export function valuationAtPrice(
  statement: FinancialStatement,
  metric: string,
  price: number,
  checkingInputs = false,
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
  // The probe at price=1 checks input coverage, not the historical EV sign.
  if (!checkingInputs && enterpriseValue !== null && enterpriseValue < 0 && (metric === "evSales" || metric === "evEbitda")) return null;
  if (metric === "evSales") return ratio(enterpriseValue, statement.totalRevenue);
  // Over EBITDA at or below zero the multiple means nothing (N/M), as a P/E over a loss.
  if (metric === "evEbitda") return isFiniteNumber(statement.ebitda) && statement.ebitda > 0 ? ratio(enterpriseValue, statement.ebitda) : null;
  if (metric === "priceFcf") return ratio(marketCap, freeCashFlow(statement).value);
  return null;
}
