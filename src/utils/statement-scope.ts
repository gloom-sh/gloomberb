import type { FinancialStatement, StatementScope, TickerFinancials } from "../types/financials";

export function listingOwnsRow(scope: StatementScope | undefined, row: FinancialStatement): boolean {
  if (!scope) return !row.statementScope;
  return scope.basis === "standalone" && !!scope.entity && row.statementScope?.basis === "standalone"
    && row.statementScope.entity === scope.entity && row.statementScope.registrant === scope.registrant;
}

export function listingOwnsSeries(data: Pick<TickerFinancials, "statementScope" | "quarterlyStatements" | "annualStatements">): boolean {
  const owned = (row: FinancialStatement) => listingOwnsRow(data.statementScope, row);
  return (!data.statementScope || data.statementScope.basis === "standalone")
    && data.annualStatements.every(owned) && data.quarterlyStatements.every(owned);
}
