import { expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { financialStatementsHeadless, historicalPricesHeadless, quoteComparisonHeadless } from "./headless";

function args(symbols: string[], options: HeadlessPaneLoadArgs["options"] = {}): HeadlessPaneLoadArgs {
  return { symbols, options, argument: symbols, rawArgument: symbols.join(",") };
}

test("financial statements keep raw values, dated growth cells, and formatted columns without requiring a quote", async () => {
  const requested: string[] = [];
  const ctx = {
    marketData: createTestDataProvider({
      async getTickerFinancials(symbol, exchange) {
        requested.push(`${symbol}:${exchange}`);
        return {
          annualStatements: [{ date: "2024-12-31", totalRevenue: 100 }, { date: "2025-12-31", totalRevenue: 150 }],
          quarterlyStatements: [], priceHistory: [],
        };
      },
    }),
  } as HeadlessPaneContext;
  const result = await financialStatementsHeadless.load(args(["AAPL:NASDAQ"], { period: "annual", statement: "income" }), ctx);
  const revenue = result.rows.find((row) => String(row.metric).includes("Revenue"))!;
  const cells = revenue.cells as Array<{ date: string; value: number; growth: number; formatted: string }>;
  expect(requested).toEqual(["AAPL:NASDAQ"]);
  expect(result.metadata).toMatchObject({ symbol: "AAPL:NASDAQ", period: "annual", statement: "income" });
  expect(revenue["2025-12-31"]).toBe(150);
  expect(cells[0]).toMatchObject({ date: "2025-12-31", value: 150, growth: 0.5 });
  const column = result.columns!.find((column) => column.key === "2025-12-31")!;
  expect(column.format!(150, revenue)).toContain(cells[0]!.formatted);
  expect(column.format!(150, revenue)).toContain("50");
});

test("quote comparison retains successful exchange-qualified inputs when a peer fails", async () => {
  const ctx = {
    signal: new AbortController().signal,
    resolveInstrument: async (symbol: string) => ({ symbol, exchange: "NYSE" }),
    marketData: createTestDataProvider({
      async getQuote(symbol, exchange) {
        if (symbol === "MISSING") throw new Error("No quote");
        expect(exchange).toBe("NYSE");
        return { symbol, name: "Company", price: 105, change: 5, changePercent: 5, currency: "USD", lastUpdated: 123 };
      },
    }),
  } as HeadlessPaneContext;
  const result = await quoteComparisonHeadless.load(args(["ABC", "MISSING"]), ctx);
  expect(result.rows).toEqual([{ symbol: "ABC", name: "Company", price: 105, change: 5, changePercent: 5, currency: "USD", marketCap: null, updatedAt: 123 }]);
  expect(result.unavailableSymbols).toEqual(["MISSING"]);
  expect(result.errors).toEqual(["MISSING: No quote"]);
});

test("historical prices use remembered exchanges and clip and sort the full OHLCV history", async () => {
  const requests: unknown[] = [];
  const ctx = {
    resolveInstrument: async () => ({ symbol: "ABC", exchange: "LSE" }),
    marketData: createTestDataProvider({
      async getPriceHistory(...request) {
        requests.push(request);
        return [
          { date: new Date("2026-03-09"), open: 20, high: 23, low: 19, close: 22, volume: 100 },
          { date: new Date("2026-01-01"), close: 10 },
          { date: new Date("2026-03-01"), close: 18 },
        ];
      },
    }),
  } as HeadlessPaneContext;
  const result = await historicalPricesHeadless.load(args(["ABC"], { range: "1M" }), ctx);
  expect(requests).toEqual([["ABC", "LSE", "1M"]]);
  expect(result.rows.map((row) => row.close)).toEqual([18, 22]);
  expect(result.rows[1]).toEqual({ date: "2026-03-09T00:00:00.000Z", open: 20, high: 23, low: 19, close: 22, volume: 100 });
});
