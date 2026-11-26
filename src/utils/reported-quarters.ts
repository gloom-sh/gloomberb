import type { ReportedQuarter, TickerFinancials } from "../types/financials";

export function missingReportedQuarters(financials?: TickerFinancials | null): ReportedQuarter[] {
  return (financials?.reportedQuarters ?? []).filter(({ date, accountingScope }) => accountingScope === "consolidated"
    && !financials?.quarterlyStatements.some((statement) => statement.date === date));
}

export function reportedQuarterNotes(quarters?: readonly ReportedQuarter[]): string[] {
  return [...(quarters ?? [])].reverse().flatMap(({ date, currency, accountingScope, amounts, evidence }) => {
    const profit = amounts.profitAttributableToOwnersOfParent;
    if (accountingScope !== "consolidated" || profit == null) return [];
    const when = evidence.publishedAt ? `filed ${evidence.publishedAt.slice(0, 10)}` : `first observed ${evidence.firstObservedAt.slice(0, 10)}; filing date unknown`;
    return [`Quarter ended ${date}: consolidated profit attributable to owners of the parent was ${currency} ${profit.toLocaleString("en-US")} (${when}). Not included in the table or its totals.`];
  });
}
