import { expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../types/financials";
import { createTestTicker } from "../test-support/ticker";
import { getColumnValue, getSortValue } from "./column-values";

const context = { activeTab: "watchlist", baseCurrency: "USD", exchangeRates: new Map([["USD", 1]]), now: Date.parse("2026-10-28T12:00:00Z") };
const column = { id: "currency", label: "CCY", width: 5, align: "left" as const };
const financials = (quote: Quote): TickerFinancials => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [], quote });

test("a row whose currency no source gave shows none, never the dollars it is valued in meanwhile", () => {
  // Solactive's gold index on Stuttgart: its quote and its search row have no currency.
  const index = createTestTicker("DE000SL0FW35.SG:XSTU", "Solactive Gold Spot Index", { exchange: "XSTU", assetCategory: "INDEX", currency: "" });
  const level: Quote = { symbol: "DE000SL0FW35.SG", price: 4061.46, currency: "", change: 0, changePercent: 0, lastUpdated: context.now, instrumentType: "INDEX" };
  // A coin pair saved before its quote came, as an older search saved it.
  const pair = createTestTicker("BTC/GBP:COINBASE PRO", "Bitcoin / British Pound", { exchange: "COINBASE PRO", currency: "" });
  for (const [ticker, data] of [[index, financials(level)], [index, undefined], [pair, undefined]] as const) {
    expect(getColumnValue(column, ticker, data, context).text, ticker.metadata.ticker).not.toContain("USD");
    expect(getSortValue(column, ticker, data, context), ticker.metadata.ticker).toBeNull();
  }
  // An index's level is in points, as `quote` prints it, whatever currency its quote names (SMIM's says CHF).
  const smim = createTestTicker("SMIM:SWX", "SMIM PR", { exchange: "SWX", assetCategory: "INDEX", currency: "" });
  expect(getColumnValue(column, smim, financials({ ...level, symbol: "SMIM", currency: "CHF" }), context).text).not.toContain("CHF");
  // A quote that names its currency still gives it.
  expect(getColumnValue(column, pair, financials({ ...level, symbol: "BTC-GBP", price: 61268.49, currency: "GBP", instrumentType: "CRYPTOCURRENCY" }), context).text).toBe("GBP");
});
