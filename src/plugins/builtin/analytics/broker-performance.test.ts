import { expect, test } from "bun:test";
import type { BrokerPortfolioPerformance } from "../../../types/trading";
import { buildPerformanceChartPoints, performanceHistoryNote, resolvePerformanceMetric } from "./broker-performance";
import { buildHistoryAxisLabel, formatHistoryAxisValue } from "./pane-model";

test("missing NAV never substitutes a percentage and deposit growth remains a value series", () => {
  const performance: BrokerPortfolioPerformance = { accountId: "test", source: "flex", period: "2026", currency: "USD", fetchedAt: 1, points: [
    { date: "2026-03-01", value: 21000, cumulativeReturn: .1 },
    { date: "2026-01-01", value: 10000, cumulativeReturn: 0 },
    { date: "2026-02-01", cumulativeReturn: .1 },
  ] };
  expect(buildPerformanceChartPoints(performance).map((point) => point.close)).toEqual([10000, 21000]);
  expect(buildHistoryAxisLabel({ performance, activePortfolio: null, baseCurrency: "EUR" })).toBe("Value (USD)");
  expect(performanceHistoryNote(performance)).toContain("1 missing value observation omitted");
  expect(performanceHistoryNote(performance)).toContain("deposits and withdrawals");
});

test("a lone or duplicated NAV cannot change a usable return series into a currency chart", () => {
  const performance: BrokerPortfolioPerformance = { accountId: "test", source: "flex", period: "2026", currency: "USD", fetchedAt: 1, points: [
    { date: "2026-01-01", cumulativeReturn: 0 },
    { date: "2026-02-01", cumulativeReturn: .1 },
    { date: "2026-03-01", value: 21000, cumulativeReturn: .1 },
    { date: "2026-03-01", value: 21000, cumulativeReturn: .1 },
  ] };
  expect(resolvePerformanceMetric(performance)).toBe("cumulativeReturn");
  expect(buildPerformanceChartPoints(performance).map((point) => point.close)).toEqual([0, .1, .1]);
  expect(buildHistoryAxisLabel({ performance, activePortfolio: null, baseCurrency: "USD" })).toBe("Return");
  expect(formatHistoryAxisValue(.1, performance)).toBe("10.0%");
});
