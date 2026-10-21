import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import type { MarketContext } from "../types";
import { createTestDataProvider } from "../../test-support/data-provider";
import { buildFinancialTableModel } from "../../plugins/builtin/ticker-detail/financials/model";
import { buildTickerReport, ticker } from "./ticker";

const config = createDefaultConfig("/tmp/gloom-ticker-period-unused");
async function reports(financials: TickerFinancials) {
  const text = (await buildTickerReport({ symbol: "PERIOD", tickerFile: null, financials, config, toBase: async value => value }))
    .replace(/\u001b\[[0-9;]*m/g, "");
  let data: any;
  await ticker("PERIOD", {
    initMarketData: async () => ({
      config, dataDir: "/tmp/gloom-ticker-period-unused",
      store: { loadTicker: async () => null }, persistence: { close: () => {} },
      dataProvider: { ...createTestDataProvider({ getTickerFinancials: async () => financials }), getNews: async () => [] },
    }) as unknown as MarketContext,
    fail: message => { throw new Error(message); }, printResult: result => { data = result.data; },
  });
  return { text, data };
}

test("ticker text and JSON agree with Financials for ascending, descending and mixed provider periods", async () => {
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
    const annual = ["2023-12-31", "2024-12-31", "2025-12-31"].map((date, index) => ({ date, currency: "USD", totalRevenue: index === 2 ? 0 : 100 }));
    const quarterly = ["2025-12-31", "2026-03-31", "2026-06-30"].map((date, index) => ({ date, currency: "EUR", totalRevenue: index === 2 ? 0 : 50 }));
    const financials = { annualStatements: order.map(i => annual[i]!), quarterlyStatements: order.map(i => quarterly[i]!), priceHistory: [] };
    const original = JSON.stringify(financials);
    const { text, data } = await reports(financials);
    expect(data.latestAnnual).toEqual(annual[2]); expect(data.latestQuarter).toEqual(quarterly[2]);
    expect(text).toContain("Latest Annual (2025-12-31)"); expect(text).toContain("Latest Quarter (2026-06-30)");
    expect(buildFinancialTableModel(financials, { period: "annual" })?.statements[0]?.date).toBe(data.latestAnnual.date);
    expect(buildFinancialTableModel(financials, { period: "quarterly" })?.statements[0]?.date).toBe(data.latestQuarter.date);
    expect(JSON.stringify(financials)).toBe(original);
  }
});

test("latest selection retains partial rows, original equal-period precedence and raw statement counts", async () => {
  const latest = { date: "2026-06-30", netIncome: 0 };
  const finalAnnual = { date: "2025-12-31", totalRevenue: 0, currency: "GBP" };
  const financials: TickerFinancials = {
    priceHistory: [],
    annualStatements: [{ date: "2025-12-31", totalRevenue: 100 }, finalAnnual, { date: "2024-12-31", totalRevenue: 200 }],
    quarterlyStatements: [latest, { date: "2026-03-31", totalRevenue: 100 }],
  };
  const { text, data } = await reports(financials);
  expect(data.latestAnnual).toEqual(finalAnnual); expect(data.latestQuarter).toEqual(latest);
  expect(data.latestQuarter.totalRevenue).toBeUndefined();
  expect(data.annualStatementCount).toBe(3); expect(data.quarterlyStatementCount).toBe(2);
  expect(text).toContain("Latest Quarter (2026-06-30)");
});

test("unqualified or absent periods never become a latest-period report", async () => {
  const financials: TickerFinancials = { annualStatements: [{ date: "TTM", totalRevenue: 1 }], quarterlyStatements: [{ date: "2026-02-29", netIncome: 2 }], priceHistory: [] };
  const { text, data } = await reports(financials);
  expect(data.latestAnnual).toBeNull(); expect(data.latestQuarter).toBeNull(); expect(text).not.toContain("Latest");
  financials.annualStatements = []; financials.quarterlyStatements = []; financials.profile = { description: "Known profile without dated reports." };
  const empty = await reports(financials);
  expect(empty.data.latestAnnual).toBeNull(); expect(empty.data.latestQuarter).toBeNull(); expect(empty.text).not.toContain("Latest");
});


test("ticker caps displayed runway while exporting raw months, labels a short TTM and skips financials", async () => {
  const financials: TickerFinancials = { annualStatements: [], priceHistory: [], quarterlyStatements: [{
    date: "2026-06-30", cashAndCashEquivalents: 32_000, operatingCashFlow: -1,
  }] };
  const { text, data } = await reports(financials);
  expect(text).toContain("Cash Runway          > 120 mo (quarter to 2026-06-30) · TTM < 4 quarters");
  expect(text).toContain("cash (no ST investments reported)");
  expect(data.cashRunway.quarter.months).toBe(96_000);
  financials.profile = { industry: "Insurance - Life" };
  const insurer = await reports(financials);
  expect(insurer.text).not.toContain("Cash Runway");
  expect(insurer.data.cashRunway).toBeNull();
});
