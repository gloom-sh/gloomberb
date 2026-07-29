import { afterEach, describe, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider } from "../../types/data-provider";
import { AssetDataRouter } from "./index";
import {
  cleanupProviderRouterTestFiles,
  createTempDbPath,
  fallbackProvider,
  makeFinancials,
  makeQuote,
} from "./test-support";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
  cleanupProviderRouterTestFiles();
});

describe("AssetDataRouter chart history", () => {
  test("does not log expected provider misses for missing chart data", async () => {
    const noisyProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async getPriceHistory() {
        throw new Error('[404] {"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}');
      },
    };
    const router = new AssetDataRouter(fallbackProvider, [noisyProvider]);
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    const history = await router.getPriceHistory("BAD", "NASDAQ", "1Y");

    expect(history).toEqual([]);
    expect(logged).toHaveLength(0);
  });

  test("falls back to later providers when the preferred chart source is empty", async () => {
    const dbPath = createTempDbPath("chart-fallback");
    const persistence = new AppPersistence(dbPath);

    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getPriceHistory() {
        return [];
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getPriceHistory() {
        return [{ date: new Date("2026-03-28T00:00:00Z"), close: 101 }];
      },
    };

    const seedRouter = new AssetDataRouter(yahooProvider, [cloudProvider], persistence.resources);
    const seeded = await seedRouter.getPriceHistory("AAPL", "NASDAQ", "1Y");
    expect(seeded[0]?.close).toBe(101);

    const cachedRouter = new AssetDataRouter(yahooProvider, [cloudProvider], persistence.resources);
    const cached = await cachedRouter.getPriceHistory("AAPL", "NASDAQ", "1Y");
    expect(cached[0]?.close).toBe(101);

    persistence.close();
  });

  test("sorts reversed chart history into chronological order", async () => {
    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      async getPriceHistory() {
        return [
          { date: new Date("2026-03-29T00:00:00Z"), close: 103 },
          { date: new Date("2026-03-27T00:00:00Z"), close: 101 },
          { date: new Date("2026-03-28T00:00:00Z"), close: 102 },
        ];
      },
    });

    const history = await router.getPriceHistory("AAPL", "NASDAQ", "1Y");

    expect(history.map((point) => point.close)).toEqual([101, 102, 103]);
  });

  test("ignores poisoned cached chart history and refetches clean data", async () => {
    const dbPath = createTempDbPath("poisoned-chart-cache");
    const persistence = new AppPersistence(dbPath);

    persistence.resources.set(
      {
        namespace: "market",
        kind: "price-history",
        entityKey: "AAPL",
        variantKey: "exchange=NASDAQ;range=1Y",
        sourceKey: "provider:yahoo",
      },
      [
        { date: null, close: 101 },
        { date: null, close: 102 },
      ],
      {
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
      },
    );

    let providerCalls = 0;
    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async getPriceHistory() {
        providerCalls += 1;
        return [
          { date: new Date("2026-03-27T00:00:00Z"), close: 201 },
          { date: new Date("2026-03-28T00:00:00Z"), close: 202 },
        ];
      },
    }, [], persistence.resources);

    const history = await router.getPriceHistory("AAPL", "NASDAQ", "1Y");

    expect(providerCalls).toBe(1);
    expect(history.map((point) => point.close)).toEqual([201, 202]);

    persistence.close();
  });

  test("ignores legacy unversioned sub-unit chart history caches", async () => {
    const dbPath = createTempDbPath("subunit-chart-cache");
    const persistence = new AppPersistence(dbPath);

    persistence.resources.set(
      {
        namespace: "market",
        kind: "price-history",
        entityKey: "FTC",
        variantKey: "exchange=LSE;range=ALL;resolution=1wk",
        sourceKey: "provider:gloomberb-cloud",
      },
      [
        { date: new Date("2026-05-21T00:00:00Z"), close: 405 },
        { date: new Date("2026-05-22T00:00:00Z"), close: 379 },
      ],
      {
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
      },
    );

    let providerCalls = 0;
    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "gloomberb-cloud",
      name: "Gloomberb Cloud",
      async getPriceHistoryForResolution() {
        providerCalls += 1;
        return [
          { date: new Date("2026-05-21T00:00:00Z"), close: 4.05 },
          { date: new Date("2026-05-22T00:00:00Z"), close: 3.79 },
        ];
      },
    }, [], persistence.resources);

    const history = await router.getPriceHistoryForResolution("FTC", "LSE", "ALL", "1wk");

    expect(providerCalls).toBe(1);
    expect(history.map((point) => point.close)).toEqual([4.05, 3.79]);

    const cachedRows = persistence.database.connection
      .query("SELECT variant_key FROM resource_cache WHERE namespace = ? AND kind = ? AND entity_key = ? ORDER BY variant_key")
      .all("market", "price-history", "FTC") as Array<{ variant_key: string }>;
    expect(cachedRows.map((row) => row.variant_key)).toEqual([
      "exchange=LSE;range=ALL;resolution=1wk",
      "exchange=LSE;range=ALL;resolution=1wk;unit=GBP",
    ]);

    persistence.close();
  });

  test("bypasses cached financials on explicit refresh requests", async () => {
    const dbPath = createTempDbPath("forced-financial-refresh");
    const persistence = new AppPersistence(dbPath);

    const seedRouter = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        return makeFinancials({
          priceHistory: [{ date: new Date("2026-03-27T00:00:00Z"), close: 101 }],
          quote: makeQuote({
            price: 101,
            change: 1,
            changePercent: 1,
          }),
        });
      },
    }, [], persistence.resources);
    await seedRouter.getTickerFinancials("AAPL", "NASDAQ");

    let providerCalls = 0;
    const refreshRouter = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        providerCalls += 1;
        return makeFinancials({
          priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 202 }],
          quote: makeQuote({
            price: 202,
            change: 2,
            changePercent: 1,
          }),
        });
      },
    }, [], persistence.resources);

    const refreshed = await refreshRouter.getTickerFinancials("AAPL", "NASDAQ", { cacheMode: "refresh" });

    expect(providerCalls).toBe(1);
    expect(refreshed.quote?.price).toBe(202);
    expect(refreshed.priceHistory[0]?.close).toBe(202);

    persistence.close();
  });

  test("refreshes stale cached chart history before falling back to cache", async () => {
    const dbPath = createTempDbPath("stale-chart-refresh");
    const persistence = new AppPersistence(dbPath);

    const seedRouter = new AssetDataRouter({
      ...fallbackProvider,
      async getPriceHistory() {
        return [{ date: new Date("2026-03-27T00:00:00Z"), close: 101 }];
      },
    }, [], persistence.resources);
    await seedRouter.getPriceHistory("AAPL", "NASDAQ", "1Y");

    persistence.database.connection
      .query("UPDATE resource_cache SET stale_at = ? WHERE namespace = ? AND kind = ? AND entity_key = ?")
      .run(Date.now() - 1, "market", "price-history", "AAPL");

    let providerCalls = 0;
    const refreshRouter = new AssetDataRouter({
      ...fallbackProvider,
      async getPriceHistory() {
        providerCalls += 1;
        return [{ date: new Date("2026-03-28T00:00:00Z"), close: 202 }];
      },
    }, [], persistence.resources);

    const history = await refreshRouter.getPriceHistory("AAPL", "NASDAQ", "1Y");

    expect(providerCalls).toBe(1);
    expect(history[0]?.close).toBe(202);

    persistence.close();
  });

  test("falls back to later providers for fixed-resolution chart history", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getPriceHistoryForResolution() {
        return [];
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getPriceHistoryForResolution() {
        return [{ date: new Date("2026-03-28T00:00:00Z"), close: 102 }];
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const history = await router.getPriceHistoryForResolution("AAPL", "NASDAQ", "1Y", "1d");

    expect(history[0]?.close).toBe(102);
  });

  test("accepts previous-session short-range chart history while the exchange is closed", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.parse("2026-05-17T12:00:00Z");

    try {
      const cloudProvider: DataProvider = {
        ...fallbackProvider,
        id: "cloud",
        name: "Cloud",
        priority: 100,
        async getPriceHistoryForResolution() {
          return [];
        },
      };
      const yahooProvider: DataProvider = {
        ...fallbackProvider,
        id: "yahoo",
        name: "Yahoo",
        priority: 1000,
        async getPriceHistoryForResolution() {
          return [
            { date: new Date("2026-05-15T15:15:00Z"), close: 101 },
            { date: new Date("2026-05-15T15:30:00Z"), close: 102 },
          ];
        },
      };

      const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
      const history = await router.getPriceHistoryForResolution("AAPL", "NASDAQ", "1M", "15m");

      expect(history.map((point) => point.close)).toEqual([101, 102]);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("returns normalized manual chart resolution capabilities", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getChartResolutionCapabilities() {
        return [];
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getChartResolutionCapabilities() {
        return ["1wk", "auto", "1d", "bogus"] as any;
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    expect(await router.getChartResolutionCapabilities("AAPL", "NASDAQ")).toEqual(["1d", "1wk"]);
  });

  test("refreshes each history request type before falling back to its cached value", async () => {
    const dbPath = createTempDbPath("forced-history-refresh");
    const persistence = new AppPersistence(dbPath);
    const startDate = new Date("2026-03-28T09:30:00Z");
    const endDate = new Date("2026-03-28T16:00:00Z");
    const seedProvider: DataProvider = {
      ...fallbackProvider,
      async getPriceHistory() {
        return [{ date: endDate, close: 101 }];
      },
      async getPriceHistoryForResolution() {
        return [{ date: endDate, close: 102 }];
      },
      async getDetailedPriceHistory() {
        return [{ date: endDate, close: 103 }];
      },
    };
    const seedRouter = new AssetDataRouter(seedProvider, [], persistence.resources);
    await seedRouter.getPriceHistory("AAPL", "NASDAQ", "1Y");
    await seedRouter.getPriceHistoryForResolution("AAPL", "NASDAQ", "1Y", "1d");
    await seedRouter.getDetailedPriceHistory("AAPL", "NASDAQ", startDate, endDate, "15m");

    const calls = { range: 0, resolution: 0, detailed: 0 };
    const refreshProvider: DataProvider = {
      ...fallbackProvider,
      async getPriceHistory() {
        calls.range += 1;
        return [];
      },
      async getPriceHistoryForResolution() {
        calls.resolution += 1;
        return [];
      },
      async getDetailedPriceHistory() {
        calls.detailed += 1;
        return [];
      },
    };
    const refreshRouter = new AssetDataRouter(refreshProvider, [], persistence.resources);

    const range = await refreshRouter.getPriceHistory("AAPL", "NASDAQ", "1Y", { cacheMode: "refresh" });
    const resolution = await refreshRouter.getPriceHistoryForResolution(
      "AAPL",
      "NASDAQ",
      "1Y",
      "1d",
      { cacheMode: "refresh" },
    );
    const detailed = await refreshRouter.getDetailedPriceHistory(
      "AAPL",
      "NASDAQ",
      startDate,
      endDate,
      "15m",
      { cacheMode: "refresh" },
    );

    expect(calls).toEqual({ range: 1, resolution: 1, detailed: 1 });
    expect([range[0]?.close, resolution[0]?.close, detailed[0]?.close]).toEqual([101, 102, 103]);

    persistence.close();
  });

  test("preserves each history request type's missing-provider result", async () => {
    const router = new AssetDataRouter(null);
    const startDate = new Date("2026-03-28T09:30:00Z");
    const endDate = new Date("2026-03-28T16:00:00Z");

    await expect(router.getPriceHistory("AAPL", "NASDAQ", "1Y"))
      .rejects.toThrow("No history provider available for AAPL");
    await expect(router.getPriceHistoryForResolution("AAPL", "NASDAQ", "1Y", "1d"))
      .rejects.toThrow("No resolution-aware history provider available for AAPL");
    await expect(router.getDetailedPriceHistory("AAPL", "NASDAQ", startDate, endDate, "15m"))
      .resolves.toEqual([]);
  });

  test("falls back to later providers when detailed chart history is empty", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getDetailedPriceHistory() {
        return [];
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getDetailedPriceHistory() {
        return [{ date: new Date("2026-03-28T10:00:00Z"), close: 102 }];
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const history = await router.getDetailedPriceHistory(
      "AAPL",
      "NASDAQ",
      new Date("2026-03-28T09:30:00Z"),
      new Date("2026-03-28T16:00:00Z"),
      "15m",
    );

    expect(history[0]?.close).toBe(102);
  });
});
