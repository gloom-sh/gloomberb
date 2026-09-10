import { expect, test } from "bun:test";
import type { DataProvider } from "../types/data-provider";
import type { PricePoint, TickerFinancials } from "../types/financials";
import { createTestDataProvider } from "../test-support/data-provider";
import { createSnapshotDataProvider } from "./snapshot-provider";

function financials(symbol: string, price: number): TickerFinancials {
  return {
    quote: { symbol, price, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1 },
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
  };
}

test("mixed snapshot/live batches preserve order and only delegate missing instruments", async () => {
  const captured = financials("AAPL", 100);
  const live = financials("MSFT", 200);
  const liveTargets = [{ symbol: "MSFT", exchange: "NASDAQ" }];
  const targets = [...liveTargets, { symbol: "AAPL", exchange: "NASDAQ" }];
  let calls = 0;
  const fallback = createTestDataProvider({
    async getTickerFinancialsBatch(missing, settings) {
      calls++;
      expect(missing).toEqual(liveTargets);
      expect(settings).toEqual({ forceRefresh: true });
      return missing.map((target) => ({ target, financials: live }));
    },
    async getQuotesBatch(missing) {
      calls++;
      expect(missing).toEqual(liveTargets);
      return missing.map((target) => ({ target, quote: live.quote! }));
    },
  });
  const provider = createSnapshotDataProvider({ financials: [["AAPL:NASDAQ", captured]] }, fallback);
  expect((await provider.getTickerFinancialsBatch!(targets, { forceRefresh: true })).map((result) => result.financials)).toEqual([live, captured]);
  expect((await provider.getQuotesBatch!(targets)).map((result) => result.quote)).toEqual([live.quote!, captured.quote!]);
  expect(calls).toBe(2);
  const cached = provider.getCachedFinancialsForTargets!([targets[1]!]);
  expect(cached).toBeInstanceOf(Map);
  expect((cached as Map<string, TickerFinancials>).get("AAPL")).toBe(captured);
});

test("snapshot matching respects exchanges and delegated methods retain their receiver", async () => {
  const captured = financials("AAPL", 100);
  const otherListing = financials("AAPL", 300);
  const options = { underlyingSymbol: "AAPL", expirationDates: [], calls: [], puts: [] };
  let fallback: DataProvider;
  fallback = createTestDataProvider({
    async getTickerFinancials(symbol, exchange) {
      expect(this).toBe(fallback);
      expect([symbol, exchange]).toEqual(["AAPL", "NYSE"]);
      return otherListing;
    },
    async getArticleSummary() { expect(this).toBe(fallback); return "live summary"; },
    getCachedQuery() { throw new Error("live cache must not bypass captured options"); },
  });
  const provider = createSnapshotDataProvider({ financials: [["AAPL:NASDAQ", captured]], optionsChains: [["AAPL:NASDAQ", options]] }, fallback);
  expect(await provider.getTickerFinancials("aapl", "NASDAQ")).toBe(captured);
  expect(await provider.getTickerFinancials("AAPL", "NYSE")).toBe(otherListing);
  const summary = provider.getArticleSummary;
  expect(await summary("https://example.com")).toBe("live summary");
  expect(await provider.getOptionsChain!("AAPL", "NASDAQ")).toBe(options);
  expect(provider.getCachedQuery).toBeUndefined();
});

test("captured intraday data rejects other intervals and clips explicit windows without refetching", async () => {
  const points: PricePoint[] = [0, 5, 10].map((minute) => ({ date: new Date(Date.UTC(2026, 8, 3, 13, 30 + minute)), close: minute }));
  const captured = { symbol: "AAPL", exchange: "NASDAQ", resolution: "5m" as const, points, unavailableReason: null };
  let liveCalls = 0;
  const fallback = createTestDataProvider({
    async getDetailedPriceHistory() { liveCalls++; return points; },
  });
  const provider = createSnapshotDataProvider({ financials: [], intradayHistories: [captured] }, fallback);
  expect(await provider.getDetailedPriceHistory!("AAPL", "NASDAQ", points[0]!.date, points[2]!.date, "5m")).toEqual(points.slice(0, 2));
  expect(await provider.getPriceHistoryForResolution!("AAPL", "NASDAQ", "1D", "1m")).toEqual([]);
  expect(liveCalls).toBe(0);
  await provider.getDetailedPriceHistory!("AAPL", "NYSE", points[0]!.date, points[2]!.date, "5m");
  expect(liveCalls).toBe(1);
  const unavailable = createSnapshotDataProvider({ financials: [], intradayHistories: [{ ...captured, points: [], unavailableReason: "Session unavailable" }] }, fallback);
  await expect(unavailable.getPriceHistory("AAPL", "NASDAQ", "1D")).rejects.toThrow("Session unavailable");
  await expect(unavailable.getDetailedPriceHistory!("AAPL", "NASDAQ", points[0]!.date, points[2]!.date, "1m")).rejects.toThrow("Session unavailable");
});

test("an ordinary captured snapshot cannot satisfy an explicit extended history request", async () => {
 const captured = financials("MSFT", 100), extended = { ...captured, annualStatements: [{ date: "2010-06-30", totalRevenue: 100 }] };
 let requests = 0;
 const provider = createSnapshotDataProvider({ financials: [["MSFT:NASDAQ", captured]] }, createTestDataProvider({
  async getTickerFinancials(_symbol, _exchange, context) { requests++; expect(context?.statementHistory).toBe("extended"); return extended; },
 }));
 expect(await provider.getTickerFinancials("MSFT", "NASDAQ")).toBe(captured);
 expect(await provider.getTickerFinancials("MSFT", "NASDAQ", { statementHistory: "extended" })).toBe(extended);
 expect((await provider.getTickerFinancialsBatch!([{ symbol: "MSFT", exchange: "NASDAQ", statementHistory: "extended" }]))[0]?.financials).toBe(extended);
 expect(requests).toBe(2);
});
