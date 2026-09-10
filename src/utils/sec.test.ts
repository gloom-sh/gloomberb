import { describe, expect, test } from "bun:test";
import type { TickerRecord } from "../types/ticker";
import { isUsEquityTicker } from "./sec";

function makeTicker(overrides: Partial<TickerRecord["metadata"]>): TickerRecord {
  return {
    metadata: {
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple Inc.",
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

describe("isUsEquityTicker", () => {
  test("accepts SMART-routed US stocks with a primary exchange", () => {
    expect(isUsEquityTicker(makeTicker({
      exchange: "SMART",
      assetCategory: "STK",
      broker_contracts: [{
        brokerId: "ibkr",
        symbol: "AAPL",
        exchange: "SMART",
        primaryExchange: "NASDAQ",
        secType: "STK",
        currency: "USD",
      }],
    }))).toBe(true);
  });

  test("accepts catalogue common stocks and depositary receipts without admitting funds or foreign listings", () => {
    for (const assetCategory of ["ADR", "Common Stock", "Depositary Receipt"]) {
      expect(isUsEquityTicker(makeTicker({ assetCategory }))).toBe(true);
      expect(isUsEquityTicker(makeTicker({ assetCategory, exchange: "LSE" }))).toBe(false);
      expect(isUsEquityTicker(makeTicker({ assetCategory, currency: "CAD" }))).toBe(false);
    }
    for (const exchange of ["XNAS", "NGM", "NCM", "XNYS", "XASE"]) {
      expect(isUsEquityTicker(makeTicker({ assetCategory: "Common Stock", exchange }))).toBe(true);
    }
    for (const assetCategory of ["OPT", "ETF", "Mutual Fund", "Preferred Stock"]) {
      expect(isUsEquityTicker(makeTicker({ assetCategory }))).toBe(false);
    }
  });
});
