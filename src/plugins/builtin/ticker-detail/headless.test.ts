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
          annualStatements: [
            { date: "2024-12-31", totalRevenue: 100, dilutedShares: 10 },
            { date: "2025-12-31", totalRevenue: 150, dilutedShares: 12 },
          ],
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
  // Exports have no expansion controls: nested dilution data must remain accessible.
  const shares = result.rows.find((row) => String(row.id) === "dilutedShares:1")!;
  expect(shares["2025-12-31"]).toBe(12);
  expect((shares.cells as Array<{ growth: number }>)[0]!.growth).toBeCloseTo(0.2);
});

test("financial exports distinguish provider dates from SEC period evidence and derived TTM", async () => {
  const dateEvidence = { accessionNumber: "0000909832-24-000049", filed: "2024-10-09", startDate: "2023-09-04" };
  const ctx = { marketData: createTestDataProvider({ async getTickerFinancials() {
    return { annualStatements: [
      { date: "2023-08-31", currency: "USD", dateSource: "provider" as const, totalRevenue: 100 },
      { date: "2024-09-01", currency: "USD", dateSource: "sec" as const, providerDate: "2024-08-31", dateEvidence, totalRevenue: 120 },
    ], quarterlyStatements: ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"].map((date) => ({
      date, currency: "USD", dateSource: "sec" as const, dateEvidence, totalRevenue: 40,
    })), priceHistory: [] };
  } }) } as HeadlessPaneContext;
  const result = await financialStatementsHeadless.load(args(["COST"], { period: "annual", statement: "income" }), ctx);
  const columns = result.metadata!.columns as Array<Record<string, unknown>>;
  expect(columns.find(({ date }) => date === "2024-09-01")).toMatchObject({ dateSource: "sec", providerDate: "2024-08-31", dateEvidence, label: "2024-09-01 USD (SEC date)" });
  expect(columns.find(({ date }) => date === "2023-08-31")).toMatchObject({ dateSource: "provider", dateEvidence: null, label: "2023-08-31 USD (provider date)" });
  expect(columns.find(({ date }) => date === "TTM")).toMatchObject({ dateSource: "derived", dateEvidence: null, providerDate: null });
  expect(columns.every((column) => !("availableAt" in column))).toBe(true);
  expect(result.columns?.find(({ key }) => key === "2023-08-31")?.header).toContain("provider date");
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
