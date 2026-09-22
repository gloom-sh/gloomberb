import { expect, test } from "bun:test";
import type { DataProvider } from "../types/data-provider";
import type { OptionsChain, PricePoint, TickerFinancials } from "../types/financials";
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

function optionsChain(expiration: number, expirationDates = [expiration]): OptionsChain {
  return {
    underlyingSymbol: "AAPL", expirationDates, puts: [],
    calls: [{
      contractSymbol: `AAPL-${expiration}`, strike: 200, currency: "USD",
      lastPrice: 5, change: 0, percentChange: 0, bid: 4.9, ask: 5.1,
      impliedVolatility: 0.3, inTheMoney: false, expiration, lastTradeDate: 1,
    }],
  };
}

test("options snapshots retain every expiry and an explicit empty slice", async () => {
  const expiries = [1_790_121_600, 1_792_108_800, 1_797_552_000];
  const near = optionsChain(expiries[0]!, expiries);
  const far = optionsChain(expiries[1]!, expiries);
  const empty = { ...optionsChain(expiries[2]!, expiries), calls: [] };
  let fallbackCalls = 0;
  const provider = createSnapshotDataProvider({
    financials: [],
    optionsChains: [["AAPL:NMS", far, expiries[1]], ["AAPL:NASDAQ", empty, expiries[2]], ["AAPL:NASDAQ", near, expiries[0]]],
  }, createTestDataProvider({
    async getOptionsChain() { fallbackCalls++; throw new Error("Unexpected live fetch"); },
  }));
  expect(await provider.getOptionsChain!("AAPL", "NASDAQ")).toBe(near);
  expect(await provider.getOptionsChain!("aapl", "NMS", expiries[0])).toBe(near);
  expect(await provider.getOptionsChain!("AAPL", "NASDAQ", expiries[1])).toBe(far);
  expect(await provider.getOptionsChain!("AAPL", "NASDAQ", expiries[2])).toBe(empty);
  expect(fallbackCalls).toBe(0);
});

test("legacy options catalogue cannot substitute its slice for another expiry or listing", async () => {
  const nearExpiry = 1_790_121_600;
  const farExpiry = 1_792_108_800;
  const near = optionsChain(nearExpiry, [nearExpiry, farExpiry]);
  const far = optionsChain(farExpiry, [nearExpiry, farExpiry]);
  const requests: unknown[][] = [];
  const provider = createSnapshotDataProvider({ financials: [], optionsChains: [["AAPL:NASDAQ", near]] }, createTestDataProvider({
    async getOptionsChain(...args) { requests.push(args); return far; },
  }));
  expect(await provider.getOptionsChain!("AAPL", "NASDAQ")).toBe(near);
  expect(await provider.getOptionsChain!("AAPL", "NASDAQ", nearExpiry)).toBe(near);
  const context = { cacheMode: "refresh" as const };
  expect(await provider.getOptionsChain!("AAPL", "NASDAQ", farExpiry, context)).toBe(far);
  expect(await provider.getOptionsChain!("AAPL", "NYSE", nearExpiry)).toBe(far);
  expect(requests).toEqual([["AAPL", "NASDAQ", farExpiry, context], ["AAPL", "NYSE", nearExpiry, undefined]]);

  const unknownSlice = { ...near, calls: [] };
  const unknown = createSnapshotDataProvider({ financials: [], optionsChains: [["AAPL", unknownSlice]] }, createTestDataProvider({
    async getOptionsChain() { return far; },
  }));
  expect(await unknown.getOptionsChain!("AAPL")).toBe(unknownSlice);
  expect(await unknown.getOptionsChain!("AAPL", undefined, nearExpiry)).toBe(far);
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

test("saved intraday calculation buffers retain leading bars but never substitute a failed, empty or different acquisition", async () => {
  const points = [0, 1, 2, 3].map(index => ({ date: new Date(Date.UTC(2026, 8, 21, 13, 30 + index * 15)), close: 100 + index }));
  const target = { symbol: "TEST", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "A", instrument: { brokerId: "ibkr", brokerInstanceId: "A", conId: 11 } };
  const captured = { target, symbol: target.symbol, exchange: target.exchange, resolution: "15m" as const,
    points: points.slice(1, 3), bufferedPoints: points, unavailableReason: null as string | null };
  let liveCalls = 0;
  const fallback = createTestDataProvider({ getDetailedPriceHistory: async () => { liveCalls++; return []; } });
  const replay = (history: typeof captured) => createSnapshotDataProvider(JSON.parse(JSON.stringify({
    financials: [["TEST:NASDAQ", { ...financials("TEST", 100), priceHistory: points }]], intradayHistories: [history],
  })), fallback);
  const provider = replay(captured);
  const start = points[1]!.date, end = points[3]!.date;
  const expected = JSON.parse(JSON.stringify(points.slice(0, 3)));
  expect(await provider.getDetailedPriceHistory!("TEST", "NASDAQ", start, end, "15m", target)).toEqual(expected);
  expect((await provider.getDetailedPriceHistoryWithMetadata!("TEST", "NASDAQ", start, end, "15m", target)).points).toEqual(expected);
  expect(await provider.getDetailedPriceHistory!("TEST", "NASDAQ", start, end, "1d", target)).toEqual([]);
  expect(await replay({ ...captured, bufferedPoints: [] }).getDetailedPriceHistory!("TEST", "NASDAQ", start, end, "15m", target)).toEqual([]);
  const legacyNull = replay(JSON.parse(JSON.stringify({ ...captured, points, bufferedPoints: null })));
  expect(await legacyNull.getDetailedPriceHistory!("TEST", "NASDAQ", start, end, "15m", target)).toEqual(expected.slice(1));
  await expect(replay({ ...captured, unavailableReason: "Session unavailable" })
    .getDetailedPriceHistory!("TEST", "NASDAQ", start, end, "15m", target)).rejects.toThrow("Session unavailable");
  expect(liveCalls).toBe(0);
  await provider.getDetailedPriceHistory!("TEST", "NASDAQ", start, end, "15m", { ...target, instrument: { ...target.instrument, conId: 12 } });
  expect(liveCalls).toBe(1);
});

test("settled captured statement extensions replay without live reads while failed extensions retain retry behavior", async () => {
  let liveCalls = 0;
  const recovered = { ...financials("TEST", 100), annualStatements: [{ date: "2025-12-31", eps: 10 }] };
  for (const status of ["available", "unsupported", "retryable-failure"] as const) {
    const captured = { ...financials("TEST", 100),
      annualStatements: status === "unsupported" ? [] : [{ date: "2024-12-31", eps: 5 }],
      statementHistory: { mode: "extended" as const, source: "sec" as const, status, fetchedAt: "2026-09-22T12:00:00Z" },
    };
    const provider = createSnapshotDataProvider({ financials: [["TEST:NASDAQ", captured]] }, createTestDataProvider({
      getTickerFinancials: async () => { liveCalls++; return recovered; },
      getCachedFinancialsForTargets: () => { liveCalls++; return new Map([["TEST", recovered]]); },
    }));
    const target = { symbol: "TEST", exchange: "NASDAQ", statementHistory: "extended" as const };
    const expected = status === "retryable-failure" ? recovered : captured;
    expect(await provider.getTickerFinancials("TEST", "NASDAQ", target)).toBe(expected);
    expect((await provider.getTickerFinancialsBatch!([target]))[0]!.financials).toBe(expected);
    expect((await provider.getCachedFinancialsForTargets!([target]))!.get("TEST")).toBe(expected);
  }
  expect(liveCalls).toBe(3);
});

test("new snapshot cadence metadata preserves opaque defaults without claiming an explicit interval", async () => {
  const points = [{ date: new Date("2026-09-01"), close: 100 }, { date: new Date("2026-09-02"), close: 102 }];
  let liveCalls = 0;
  const live = createTestDataProvider({ getPriceHistory: async () => { liveCalls++; return []; }, getPriceHistoryForResolution: async () => { liveCalls++; return []; } });
  const captured = { ...financials("BTC-USD", 102), priceHistory: points, priceHistoryResolution: null };
  const opaque = createSnapshotDataProvider({ financials: [["BTC-USD:CCC", captured]] }, live);
  expect(await opaque.getChartResolutionSupport!("BTC-USD", "CCC")).toEqual([]);
  expect(await opaque.getPriceHistoryForResolution!("BTC-USD", "CCC", "1M", "15m")).toEqual([]);
  expect(await opaque.getDetailedPriceHistory!("BTC-USD", "CCC", points[0]!.date, new Date("2026-09-03"), "1d")).toEqual([]);
  expect(await opaque.getPriceHistory("BTC-USD", "CCC", "1M")).toEqual(points);
  expect(await opaque.getPriceHistoryWithMetadata!("BTC-USD", "CCC", "1M")).toEqual({ points, resolution: null });
  const known = createSnapshotDataProvider({ financials: [["BTC-USD:CCC", { ...captured, priceHistoryResolution: "1d" }]] }, live);
  expect(await known.getChartResolutionSupport!("BTC-USD", "CCC")).toEqual([{ resolution: "1d", maxRange: "ALL" }]);
  expect(await known.getPriceHistoryForResolution!("BTC-USD", "CCC", "1M", "15m")).toEqual([]);
  expect(await known.getPriceHistoryForResolution!("BTC-USD", "CCC", "1M", "1d")).toEqual(points);
  expect(await known.getPriceHistoryWithMetadata!("BTC-USD", "CCC", "1M")).toEqual({ points, resolution: "1d" });
  const { priceHistoryResolution: _metadata, ...legacy } = captured;
  expect(await createSnapshotDataProvider({ financials: [["BTC-USD:CCC", legacy]] }, live).getPriceHistoryForResolution!("BTC-USD", "CCC", "1M", "15m")).toEqual(points);
  expect(liveCalls).toBe(0);
});

test("snapshot variants replay each acquired cadence and broker contract separately across JSON serialization", async () => {
  const fine = [{ date: new Date("2026-09-01T09:00:00Z"), close: 1 }, { date: new Date("2026-09-01T09:15:00Z"), close: 2 }];
  const daily = [{ date: new Date("2026-09-01"), close: 100 }], unknown = [{ date: new Date("2026-09-01"), close: 200 }];
  const target = { symbol: "TEST", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "account-A", instrument: { brokerId: "ibkr", brokerInstanceId: "account-A", conId: 11 } };
  let liveCalls = 0;
  const provider = createSnapshotDataProvider(JSON.parse(JSON.stringify({ financials: [], historyVariants: [
    { target, resolution: "15m", points: fine }, { target, resolution: "1d", points: daily }, { target, resolution: null, points: unknown },
  ] })), createTestDataProvider({ getDetailedPriceHistory: async () => { liveCalls++; return []; } }));
  const from = new Date("2026-09-01"), to = new Date("2026-09-02");
  expect((await provider.getDetailedPriceHistory!("TEST", "NASDAQ", from, to, "15m", target)).map(point => point.close)).toEqual([1, 2]);
  expect((await provider.getPriceHistoryForResolution!("TEST", "NASDAQ", "1M", "1d", target)).map(point => point.close)).toEqual([100]);
  expect((await provider.getPriceHistory("TEST", "NASDAQ", "1M", target)).map(point => point.close)).toEqual([200]);
  expect(await provider.getPriceHistoryForResolution!("TEST", "NASDAQ", "1M", "1wk", target)).toEqual([]);
  expect(await provider.getChartResolutionSupport!("TEST", "NASDAQ", target)).toEqual([{ resolution: "15m", maxRange: "ALL" }, { resolution: "1d", maxRange: "ALL" }]);
  expect(liveCalls).toBe(0);
  await provider.getDetailedPriceHistory!("TEST", "NASDAQ", from, to, "15m", { ...target, instrument: { ...target.instrument, conId: 12 } });
  expect(liveCalls).toBe(1);
});

test("opaque snapshot variants remain isolated by their original acquisition request", async () => {
  const target = { symbol: "TEST", exchange: "NASDAQ" };
  const market = [{ date: new Date("2026-09-01"), close: 100 }];
  const valuation = [{ date: new Date("2026-08-01"), close: 90 }, { date: new Date("2026-09-01"), close: 200 }];
  let liveCalls = 0;
  const provider = createSnapshotDataProvider({ financials: [], historyVariants: [
    { target, resolution: null, requestKey: "market-window", points: market },
    { target, resolution: null, requestKey: "valuation-all", points: valuation },
  ] }, createTestDataProvider({ getPriceHistory: async () => { liveCalls++; return market; } }));
  expect(await provider.getPriceHistory("TEST", "NASDAQ", "1M", { historyRequestKey: "market-window" })).toEqual(market);
  expect(await provider.getPriceHistory("TEST", "NASDAQ", "ALL", { historyRequestKey: "valuation-all" })).toEqual(valuation);
  expect(await provider.getPriceHistory("TEST", "NASDAQ", "1M", { historyRequestKey: "different-window" })).toEqual([]);
  expect(await provider.getPriceHistory("TEST", "NASDAQ", "1M")).toEqual([]);
  expect(await provider.getPriceHistoryForResolution!("TEST", "NASDAQ", "1M", "1d", { historyRequestKey: "market-window" })).toEqual([]);
  expect(liveCalls).toBe(0);
});
