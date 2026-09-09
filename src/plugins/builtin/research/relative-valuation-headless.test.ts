import { expect, test } from "bun:test";
import type { HeadlessPaneContext } from "../../../types/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
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
          fundamentals: { enterpriseValue: 200, revenue: symbol === "ZERO" ? 0 : 50, freeCashFlow: 5, revenueGrowth: 0, lastQuarterGrowth: 0.2, operatingMargin: 0.1 },
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
