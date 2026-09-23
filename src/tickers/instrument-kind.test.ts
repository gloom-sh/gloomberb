import { expect, test } from "bun:test";
import { createTestTicker } from "../test-support/pane";
import type { TickerFinancials } from "../types/financials";
import { resolveTickerInstrumentKind } from "./instrument-kind";

const quoted = (instrumentType: string): Pick<TickerFinancials, "quote"> => ({
  quote: { symbol: "X", instrumentType, currency: "USD", price: 1, change: 0, changePercent: 0, lastUpdated: 0 },
});

test.each([
  // A broker files ETFs under its generic stock type; the quote's fund type wins.
  ["broker STK, quote ETF", createTestTicker("IBIT", "iShares Bitcoin Trust", { assetCategory: "STK" }), quoted("ETF"), "fund"],
  ["saved ETF, generic quote", createTestTicker("SPY", "SPDR S&P 500", { assetCategory: "ETF" }), quoted("EQUITY"), "fund"],
  ["cached metadata only", createTestTicker("VWRA", "Vanguard FTSE All-World", { assetCategory: "STK" }),
    { quoteMetadata: { symbol: "VWRA", instrumentType: "ETF", source: {} } }, "fund"],
  ["crypto venue before any quote", createTestTicker("BTC-USD", "Bitcoin USD", { exchange: "CCC" }), null, "crypto"],
  ["index syntax", createTestTicker("^GSPC", "S&P 500", { exchange: "" }), null, "index"],
  ["bare symbol", createTestTicker("AAPL", "Apple"), null, "equity"],
] as const)("%s", (_label, ticker, financials, kind) => {
  expect(resolveTickerInstrumentKind(ticker, financials)).toBe(kind);
});
