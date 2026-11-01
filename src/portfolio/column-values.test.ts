import { expect, spyOn, test } from "bun:test";
import * as positionMetrics from "./position-metrics";
import { getColumnValue, getSortValue, sharePositionMetrics } from "./column-values";
import type { TickerFinancials } from "../types/financials";
import { createTestTicker } from "../test-support/ticker";

const column = (id: string) => ({ id, label: id, width: 12, align: "right" as const });

test("a shared context works out a row's position figures once per quote, across cells and sort keys", () => {
  const record = createTestTicker("AAPL", "Apple", {
    assetCategory: "STK", portfolios: ["main"],
    positions: [{ portfolio: "main", broker: "manual", shares: 10, avgCost: 100, currency: "USD" }],
  });
  const quote = { symbol: "AAPL", price: 120, currency: "USD", change: 0, changePercent: 0, previousClose: 120, lastUpdated: 1 };
  const financials = { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] } as TickerFinancials;
  const base = { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map([["USD", 1]]), now: 0 };
  const cells = sharePositionMetrics({ ...base, now: 1 }, base);
  const sort = sharePositionMetrics({ ...base, now: 2 }, base);
  const computed = spyOn(positionMetrics, "getPortfolioPositionMetrics");
  try {
    for (const id of ["mkt_value", "pnl", "pnl_pct", "cost_basis"]) getColumnValue(column(id), record, financials, cells);
    expect(getSortValue(column("pnl"), record, financials, sort)).toBe(200);
    // Its own currency and the pane's: once each.
    expect(computed).toHaveBeenCalledTimes(2);

    const ticked = { ...financials, quote: { ...quote, price: 130 } };
    expect(getColumnValue(column("pnl"), record, ticked, cells).text).toBe("+300.00");
    expect(getSortValue(column("pnl"), record, ticked, sort)).toBe(300);
    expect(computed).toHaveBeenCalledTimes(4);
  } finally {
    computed.mockRestore();
  }
});

test("a context that shares an owner but not its tab, currency or rates works its row figures out again", () => {
  const record = createTestTicker("AAPL", "Apple", {
    assetCategory: "STK", portfolios: ["main"],
    positions: [{ portfolio: "main", broker: "manual", shares: 10, avgCost: 100, currency: "USD" }],
  });
  const quote = { symbol: "AAPL", price: 120, currency: "USD", change: 0, changePercent: 0, previousClose: 120, lastUpdated: 1 };
  const financials = { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] } as TickerFinancials;
  const owner = {};
  const shared = (ctx: Partial<Parameters<typeof getSortValue>[3]>) => sharePositionMetrics({
    activeTab: "main", baseCurrency: "USD", exchangeRates: new Map([["USD", 1], ["EUR", 2]]), now: 0, ...ctx,
  }, owner);
  const cost = (ctx: Parameters<typeof getSortValue>[3]) => getSortValue(column("cost_basis"), record, financials, ctx);

  expect(cost(shared({}))).toBe(1_000);
  expect(cost(shared({ activeTab: "ira" }))).toBeNull();
  expect(cost(shared({ baseCurrency: "EUR" }))).toBe(500);
  expect(cost(shared({ baseCurrency: "EUR", exchangeRates: new Map([["USD", 1], ["EUR", 4]]) }))).toBe(250);
});
