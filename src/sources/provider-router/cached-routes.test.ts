import { describe, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { MarketDataCoordinator } from "../../market-data/coordinator";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { BrokerAdapter } from "../../types/broker";
import { AssetDataRouter } from "./index";
import { attachTestRegistry, brokerInstance, createBrokerConfig } from "./test-support";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("shared cached market queries", () => {
  test("USD identity works offline without fetching or expiring from its undated static cache", async () => {
    let calls = 0;
    const provider = createTestDataProvider({ id: "offline", getExchangeRate: async () => { calls++; throw new Error("offline"); } });
    const router = new AssetDataRouter(provider);
    expect(await router.getExchangeRate("USD")).toBe(1);
    expect(router.getCachedExchangeRates(["USD"]).get("USD")).toBe(1);
    expect(router.getCachedExchangeRates(["USD"], { allowExpired: false }).get("USD")).toBe(1);
    expect(calls).toBe(0);
  });
  test("retries partial corporate actions and invalidates cached estimates without reporting currency", async () => {
    const persistence = new AppPersistence(":memory:");
    let actionCalls = 0;
    let analystCalls = 0;
    const provider = createTestDataProvider({ id: "research",
      getCorporateActions: async () => ({ symbol: "BABA", dividends: [], splits: [], earnings: [],
        coverage: { earnings: ++actionCalls === 1 ? "unavailable" as const : "available" as const } }),
      getAnalystResearch: async () => { analystCalls++; return { symbol: "BABA", recommendations: [], ratings: [],
        earningsEstimates: [{ date: "2026-09-30", period: "current quarter", currency: "CNY", average: 10.97 }], revenueEstimates: [] }; },
    });
    persistence.resources.set({ namespace: "market", kind: "analystResearch", entityKey: "BABA", sourceKey: "provider:research" },
      { symbol: "BABA", currency: "USD", recommendations: [], ratings: [], earningsEstimates: [{ date: "2026-09-30", period: "current quarter", average: 10.97 }], revenueEstimates: [] },
      { cachePolicy: { staleMs: 86400000, expireMs: 86400000 } });
    const router = new AssetDataRouter(provider, [], persistence.resources);
    try {
      expect((await router.getAnalystResearch("BABA")).earningsEstimates[0]?.currency).toBe("CNY");
      expect(analystCalls).toBe(1);
      expect((await router.getCorporateActions("BABA")).coverage?.earnings).toBe("unavailable");
      expect((await router.getCorporateActions("BABA")).coverage?.earnings).toBe("available");
      expect(actionCalls).toBe(2);
    } finally { persistence.close(); }
  });
  test("preserves stale FX age, shares refreshes, notifies consumers, and unsubscribes on destroy", async () => {
    const persistence = new AppPersistence(":memory:");
    const pending = deferred<number>();
    let calls = 0;
    const provider = createTestDataProvider({ id: "fx", getExchangeRate: () => { calls += 1; return pending.promise; } });
    const fetchedAt = Date.now() - 2 * 60 * 60_000;
    persistence.resources.set({ namespace: "market", kind: "exchange-rate", entityKey: "EUR/USD", sourceKey: "provider:fx" }, { rate: 1.08 }, {
      fetchedAt, cachePolicy: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
    });
    const router = new AssetDataRouter(provider, [], persistence.resources);
    const first = new MarketDataCoordinator(router);
    const second = new MarketDataCoordinator(router);
    let notifications = 0;
    second.subscribeKeys(["fx:EUR"], () => { notifications += 1; });
    try {
      const before = await first.loadFxRate("EUR");
      expect(before).toMatchObject({ data: 1.08, fetchedAt, source: "fx", phase: "refreshing" });
      expect(before.staleAt).toBeLessThan(Date.now());
      await second.loadFxRate("EUR");
      expect(calls).toBe(1);
      first.destroy();
      pending.resolve(1.12);
      await tick();
      await tick();
      expect(second.getFxEntry("EUR")).toMatchObject({ data: 1.12, source: "fx", phase: "ready", error: null });
      expect(second.getFxEntry("EUR").fetchedAt).toBeGreaterThan(fetchedAt);
      expect(first.getFxEntry("EUR").data).toBe(1.08);
      expect(notifications).toBeGreaterThan(0);
      expect((await second.loadFxRate("EUR")).data).toBe(1.12);
      expect(calls).toBe(1);
    } finally { first.destroy(); second.destroy(); persistence.close(); }
  });

  test("shares cold loads with direct provider calls and keeps errors attached to stale fallback", async () => {
    let calls = 0;
    const pending = deferred<number>();
    const provider = createTestDataProvider({ id: "fx", getExchangeRate: () => {
      calls += 1;
      return calls === 1 ? pending.promise : Promise.reject(new Error("offline"));
    } });
    const router = new AssetDataRouter(provider);
    const coordinator = new MarketDataCoordinator(router);
    try {
      const first = coordinator.loadFxRate("EUR");
      const direct = router.getExchangeRate("EUR");
      await tick();
      expect(calls).toBe(1);
      pending.resolve(1.12);
      const entry = await first;
      expect(await direct).toBe(1.12);
      const query = router.getCachedQuery("getExchangeRate", ["EUR"]);
      await query.load({ force: true });
      expect(coordinator.getFxEntry("EUR")).toMatchObject({ data: 1.12, fetchedAt: entry.fetchedAt, phase: "ready" });
      expect(coordinator.getFxEntry("EUR").error?.message).toBe("No exchange rate provider available for EUR");
      expect(calls).toBe(2);
    } finally { coordinator.destroy(); }
  });

  test("keeps broker account options separate and explicit refresh bypasses fresh queries", async () => {
    const calls: string[] = [];
    const broker: BrokerAdapter = {
      id: "ibkr", name: "IBKR", configSchema: [], validate: async () => true, importPositions: async () => [],
      getOptionsChain: async (_ticker, instance) => {
        calls.push(instance.id);
        return { underlyingSymbol: "AAPL", expirationDates: [calls.length], calls: [], puts: [] };
      },
    };
    const router = new AssetDataRouter(createTestDataProvider());
    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    const config = createBrokerConfig([brokerInstance({ id: "one" }), brokerInstance({ id: "two" })]);
    router.setConfigAccessor(() => config);
    const one = { brokerId: "ibkr", brokerInstanceId: "one" };
    const two = { brokerId: "ibkr", brokerInstanceId: "two" };
    expect((await router.getOptionsChain("AAPL", "NASDAQ", undefined, one)).expirationDates).toEqual([1]);
    expect((await router.getOptionsChain("AAPL", "NASDAQ", undefined, two)).expirationDates).toEqual([2]);
    expect((await router.getOptionsChain("AAPL", "NASDAQ", undefined, one)).expirationDates).toEqual([1]);
    expect((await router.getOptionsChain("AAPL", "NASDAQ", undefined, { ...one, cacheMode: "refresh" })).expirationDates).toEqual([3]);
    expect(calls).toEqual(["one", "two", "one"]);
  });
  test("refresh forwards cache mode to providers and rejects malformed cached exchange rates", async () => {
    const persistence = new AppPersistence(":memory:");
    const modes: Array<string | undefined> = [];
    const provider = createTestDataProvider({ id: "provider",
      getOptionsChain: async (_symbol, _exchange, _expiration, context) => {
        modes.push(context?.cacheMode);
        return { underlyingSymbol: "AAPL", expirationDates: [1], calls: [], puts: [] };
      },
      getExchangeRate: async () => 1.15,
    });
    const router = new AssetDataRouter(provider, [], persistence.resources);
    try {
      await router.getOptionsChain("AAPL");
      await router.getOptionsChain("AAPL", undefined, undefined, { cacheMode: "refresh" });
      expect(modes).toEqual([undefined, "refresh"]);
      persistence.resources.set({ namespace: "market", kind: "exchange-rate", entityKey: "EUR/USD", sourceKey: "provider:provider" },
        { rate: 0 }, { cachePolicy: { staleMs: 60_000, expireMs: 120_000 } });
      expect(await router.getExchangeRate("EUR")).toBe(1.15);
    } finally { persistence.close(); }
  });

  test("FX source observation and retrieval times survive cache reload and failed refresh", async () => {
    const now = Date.now();
    const fetchedAt = now - 30 * 60_000;
    const asOf = now - 45 * 60_000;
    let calls = 0;
    const persistence = new AppPersistence(":memory:");
    const provider = createTestDataProvider({ id: "cloud", getExchangeRateSnapshot: async () => {
      if (++calls > 1) throw new Error("offline");
      return { fromCurrency: "EUR", toCurrency: "USD", rate: 1.16, source: "yahoo", asOf: new Date(asOf).toISOString(),
        fetchedAt: new Date(fetchedAt).toISOString(), staleAt: new Date(now + 30 * 60_000).toISOString(), stale: false };
    } });
    const router = new AssetDataRouter(provider, [], persistence.resources);
    const coordinator = new MarketDataCoordinator(router);
    const reloaded = new AssetDataRouter(provider, [], persistence.resources);
    try {
      expect(await coordinator.loadFxRate("EUR")).toMatchObject({ data: 1.16, source: "yahoo", fetchedAt, asOf });
      expect(await reloaded.getExchangeRate("EUR")).toBe(1.16);
      expect(reloaded.getCachedQuery("getExchangeRate", ["EUR"]).getSnapshot().result).toMatchObject({ source: "yahoo", fetchedAt, asOf });
      expect(calls).toBe(1);
      await router.getCachedQuery("getExchangeRate", ["EUR"]).load({ force: true });
      expect(coordinator.getFxEntry("EUR")).toMatchObject({ data: 1.16, source: "yahoo", fetchedAt, asOf });
      expect(coordinator.getFxEntry("EUR").error).not.toBeNull();
      expect(calls).toBe(2);
    } finally { coordinator.destroy(); persistence.close(); }
  });

  test("expired numeric FX fallback also rejects a mismatched pair", () => {
    const persistence = new AppPersistence(":memory:");
    const provider = createTestDataProvider({ id: "fx" });
    persistence.resources.set({ namespace: "market", kind: "exchange-rate", entityKey: "EUR/USD", sourceKey: "provider:fx" },
      { fromCurrency: "JPY", toCurrency: "USD", rate: 0.0065 },
      { fetchedAt: Date.now() - 10_000, cachePolicy: { staleMs: 1, expireMs: 2 } });
    const router = new AssetDataRouter(provider, [], persistence.resources);
    try {
      expect(router.getCachedExchangeRates(["EUR"], { allowExpired: true }).has("EUR")).toBe(false);
    } finally { persistence.close(); }
  });

  test("FX memory, persistence and renderer fallbacks expire by source time during a failed refresh", async () => {
    const actualNow = Date.now;
    let now = actualNow();
    const sourceTime = now - 7 * 86_400_000 + 1000;
    Date.now = () => now;
    const persistence = new AppPersistence(":memory:");
    let calls = 0;
    const provider = createTestDataProvider({ id: "fx", getExchangeRateSnapshot: async () => {
      if (++calls > 1) throw new Error("offline");
      return { rate: 1.16, fromCurrency: "EUR", toCurrency: "USD", source: "yahoo", asOf: new Date(sourceTime).toISOString(), fetchedAt: new Date(now).toISOString(), stale: true };
    } });
    const router = new AssetDataRouter(provider, [], persistence.resources);
    const coordinator = new MarketDataCoordinator(router);
    try {
      expect((await coordinator.loadFxRate("EUR")).data).toBe(1.16);
      now += 2000;
      expect(router.getCachedExchangeRates(["EUR"], { allowExpired: true }).has("EUR")).toBe(false);
      const entry = await coordinator.loadFxRate("EUR");
      expect(entry.data).toBeNull();
      expect(entry.lastGoodData).toBeNull();
      expect(entry.error).not.toBeNull();
      await expect(router.getExchangeRate("EUR")).rejects.toThrow();
    } finally { Date.now = actualNow; coordinator.destroy(); persistence.close(); }
  });

});
