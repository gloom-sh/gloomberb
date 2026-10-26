import { expect, test } from "bun:test";
import { renderFundamentalsReport } from "../cli/commands/ticker";
import type { FinancialStatement, Fundamentals, Quote, SplitShareBasis, TickerFinancials } from "../types/financials";
import { withFiledTrailingEps } from "./filed-trailing-eps";

// The evening of 2026-11-16: four quarters of 1.00, the last filed on 2026-10-29, at a price of 100.
const NOW = Date.parse("2026-11-16T22:00:00.000Z");
const quote: Quote = { symbol: "UNITTEST", name: "Unit Test", price: 100, previousClose: 100, change: 0, changePercent: 0, currency: "USD", lastUpdated: NOW };
const quarter = (date: string, filed: string): FinancialStatement => ({ date, currency: "USD", eps: 1, fieldAvailability: { eps: filed } });
const financials = (fundamentals: Fundamentals, quarterlyStatements: FinancialStatement[] = [
  quarter("2025-12-31", "2026-02-10"), quarter("2026-03-31", "2026-04-30"), quarter("2026-06-30", "2026-07-30"), quarter("2026-09-30", "2026-10-29"),
]): TickerFinancials => ({ quote, fundamentals, financialCurrency: "USD", quarterlyStatements, annualStatements: [], priceHistory: [] });
const headline = (fundamentals: Fundamentals) => {
  const priced = withFiledTrailingEps(financials(fundamentals), NOW).fundamentals!;
  return { eps: priced.eps, trailingPE: priced.trailingPE, source: priced.trailingEpsSource };
};
const FILED = { eps: 4, trailingPE: 25, source: "filed-quarters" };

test("a split gone ex after the last EPS was filed leaves Gloom Cloud's figure, labelled", () => {
  const split = (exDate: string): SplitShareBasis => ({ exDate, priceFactor: 0.1, method: "provider_cap", reportedShares: 1e8 });
  // The statements are on the old share count: 4.00 would put the P/E at 25 against 250.
  expect(headline({ eps: 0.4, trailingPE: 250, splitShareBasis: split("2026-11-05") })).toEqual({ eps: 0.4, trailingPE: 250, source: "served" });
  // The last 10-Q came after the split, so its figures are on the new count.
  expect(headline({ eps: 3.9, trailingPE: 25.64, splitShareBasis: split("2026-10-01") })).toEqual(FILED);
});

test("a filed figure more than 1.5x Gloom Cloud's either way reads as another share basis", () => {
  for (const served of [2.5, 6.5, -4, 0]) expect(headline({ eps: served, trailingPE: 30 }).source).toBe("served");
  for (const served of [3, 5.5]) expect(headline({ eps: served, trailingPE: 30 })).toEqual(FILED);
});

test("a P/E served with no EPS, a fund's, is labelled Gloom Cloud's where it shows", () => {
  const fund = withFiledTrailingEps(financials({ trailingPE: 22.5 }, []), NOW);
  expect(fund.fundamentals?.trailingEpsSource).toBe("served");
  const valuation = renderFundamentalsReport({ ...fund, symbol: "UNITTEST" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  expect(valuation).toContain("P/E (TTM) 22.50");
  expect(valuation).toContain("P/E (TTM) is Gloom Cloud's trailing figure, not the last four filed quarters'.");
});
