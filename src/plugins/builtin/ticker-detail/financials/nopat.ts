import type { FinancialStatement } from "../../../../types/financials";

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Operating income after tax at the period's effective rate (tax provision ÷ pretax income, held between 0% and
 * 100%); a pretax loss pays no tax. Undefined when a line is missing. ROIC and the reinvestment rate read it.
 */
export function statementNopat(statement: FinancialStatement): number | undefined {
  const operating = finite(statement.operatingIncome);
  const tax = finite(statement.taxProvision);
  const pretax = finite(statement.pretaxIncome);
  if (operating === undefined || tax === undefined || pretax === undefined) return undefined;
  const rate = pretax > 0 ? Math.min(1, Math.max(0, tax / pretax)) : 0;
  return operating * (1 - rate);
}
