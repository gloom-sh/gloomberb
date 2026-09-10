import { expect, test } from "bun:test";
import type { HeadlessPaneContext } from "../../../types/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { comparableMarketCap, relativeValuationValues } from "./relative-valuation-model";
import { relativeValuationHeadless } from "./relative-valuation-headless";

test("relative valuations share derived metrics, preserve zeroes, and identify missing peers", async () => {
  const symbols = ["GOOD", "ZERO", "EMPTY", "MISSING"];
  const ctx = {
    signal: new AbortController().signal,
    marketData: createTestDataProvider({
      async getTickerFinancials(symbol) {
        if (symbol === "MISSING") throw new Error("Unavailable");
        const empty = { annualStatements: [], quarterlyStatements: [], priceHistory: [] };
        if (symbol === "EMPTY") return empty;
        return {
          ...empty,
          quote: { symbol, price: 10, change: 1, changePercent: 10, currency: "USD", lastUpdated: 1, marketCap: symbol === "ZERO" ? 0 : 100 },
          fundamentals: { financialCurrency: "USD", enterpriseValue: 200, revenue: symbol === "ZERO" ? 0 : 50, freeCashFlow: 5, revenueGrowth: 0, lastQuarterGrowth: 0.2, operatingMargin: 0.1 },
        };
      },
    }),
  } as HeadlessPaneContext;
  const result = await relativeValuationHeadless.load({ symbols, argument: symbols, rawArgument: symbols.join(","), options: {} }, ctx);
  expect(result.rows[0]).toMatchObject({ evSales: 4, fcfYield: 0.05, revenueGrowth: 0, operatingMargin: 0.1 });
  expect(result.rows[1]).toMatchObject({ marketCap: 0, evSales: null, fcfYield: null, revenueGrowth: 0 });
  expect(result.unavailableSymbols).toEqual(["MISSING", "EMPTY"]);
  expect(result.errors).toEqual(["MISSING: Unavailable"]);
});


test("relative valuation does not divide unconverted foreign cash flows by a USD market value", () => {
  const financials = {
    annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: "TWD",
    quote: { symbol: "TSM", price: 200, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, marketCap: 100 },
    fundamentals: { financialCurrency: "TWD", enterpriseValue: 110, revenue: 1000, freeCashFlow: 300, operatingMargin: 0.4 },
  };
  expect(relativeValuationValues(financials)).toMatchObject({ evSales: null, fcfYield: null, operatingMargin: 0.4 });
  // Converted summary fundamentals are independent of the statement currency.
  financials.fundamentals.financialCurrency = "";
  expect(relativeValuationValues(financials)).toMatchObject({ evSales: null, fcfYield: null });
  financials.fundamentals.financialCurrency = "USD";
  expect(relativeValuationValues(financials)).toMatchObject({ evSales: 0.11, fcfYield: 3 });
});


test("peer market caps convert before ranking and missing FX never becomes a 1:1 conversion", () => {
  const rates = new Map([["JPY", 0.0065], ["GBP", 1.3]]);
  expect(comparableMarketCap(1e12, "JPY", "USD", rates)).toBe(6.5e9);
  expect(comparableMarketCap(1e9, "GBP", "USD", rates)).toBe(1.3e9);
  expect(comparableMarketCap(1e9, "EUR", "USD", rates)).toBeNull();
});


test("provider EV/S requires verified compatible reporting units even when a ratio is supplied", () => {
  // Reproduces the ADR summary whose vendor EV is inconsistent with its market cap.
  const financials = { annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: "TWD",
    quote: { symbol: "TSM", price: 426.22, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, marketCap: 2_257_983_274_434 },
    fundamentals: { financialCurrency: undefined as string | undefined, enterpriseToRevenue: 3.56, enterpriseValue: 501_458_070_727, revenue: 140_865_738_606 },
  };
  expect(relativeValuationValues(financials)).toMatchObject({ evSales: null, marketCap: 2_257_983_274_434 });
  financials.fundamentals.financialCurrency = "TWD";
  expect(relativeValuationValues(financials).evSales).toBeNull();

  // A separately verified summary currency permits the provider ratio; the
  // statement currency never supplies missing summary metadata.
  financials.fundamentals = { financialCurrency: "USD", enterpriseToRevenue: 4.2, enterpriseValue: 100, revenue: 25 };
  expect(relativeValuationValues(financials).evSales).toBe(4.2);
  financials.fundamentals.enterpriseToRevenue = NaN;
  expect(relativeValuationValues(financials).evSales).toBe(4);
});
