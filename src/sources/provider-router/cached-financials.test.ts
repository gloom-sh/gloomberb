import { afterEach, describe, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider } from "../../types/data-provider";
import { AssetDataRouter } from "./index";
import { mergeFinancials, sanitizeCachedFinancials } from "./financials";
import {
  cleanupProviderRouterTestFiles,
  createTempDbPath,
  fallbackProvider,
  makeFinancials,
  makeQuote,
} from "./test-support";

afterEach(() => {
  cleanupProviderRouterTestFiles();
});

test("confirmed fund classification prevents cached company accounts from returning after merge", () => {
  const now = Date.now();
  const fund = makeFinancials({ quote: makeQuote({ symbol: "IWDA.L", providerId: "gloomberb-cloud", instrumentType: "ETF", currency: "USD", lastUpdated: now }) });
  const contaminated = makeFinancials({
    quote: makeQuote({ symbol: "IWDA.L", providerId: "yahoo", currency: "USD", lastUpdated: now - 1000 }),
    fundamentals: { trailingPE: 0.238, revenue: 0 }, profile: { industry: "Specialty Chemicals" },
    annualStatements: [{ date: "2025-12-31", totalRevenue: 0 }],
  });
  const merged = mergeFinancials(fund, contaminated)!;
  expect(merged.quote?.instrumentType).toBe("ETF");
  expect(merged.fundamentals).toBeUndefined();
  expect(merged.profile).toBeUndefined();
  expect(merged.annualStatements).toEqual([]);
  expect(sanitizeCachedFinancials({ ...contaminated, quote: fund.quote }, { includeStaleQuotes: true }).fundamentals).toBeUndefined();
  expect(mergeFinancials(contaminated, null)?.fundamentals?.trailingPE).toBe(0.238);
});

test("fund research keeps distribution yield and description through cache and merge boundaries", () => {
  const now = Date.now();
  const fund = makeFinancials({
    quote: makeQuote({ symbol: "SGOV", providerId: "gloomberb-cloud", instrumentType: "ETF", lastUpdated: now }),
    fundamentals: { dividendYield: 0.036658540225881886, dividendYieldBasis: "forward", dividendYieldSource: "twelvedata", source: "twelvedata", fetchedAt: "2026-09-10T22:30:00Z", stale: true,
      enterpriseValue: 0, revenue: 0, netIncome: 0, freeCashFlow: 0 },
    profile: { description: "Short Treasury bond fund", sector: "Contaminated issuer sector" },
    annualStatements: [{ date: "2025-12-31", totalRevenue: 0 }],
  });
  for (const value of [sanitizeCachedFinancials(fund, { includeStaleQuotes: true }), mergeFinancials(fund, null)!]) {
    expect(value.fundamentals).toEqual({ dividendYield: 0.036658540225881886, dividendYieldBasis: "forward", dividendYieldSource: "twelvedata", source: "twelvedata", fetchedAt: "2026-09-10T22:30:00Z", stale: true });
    expect(value.profile).toEqual({ description: "Short Treasury bond fund" });
    expect(value.annualStatements).toEqual([]);
  }
  const company = makeFinancials({
    quote: makeQuote({ symbol: "SGOV", providerId: "yahoo", instrumentType: "EQUITY", lastUpdated: now - 1000 }),
    fundamentals: { dividendYield: 0.99, revenue: 0 }, profile: { description: "Wrong company" },
  });
  const emptyFund = makeFinancials({ quote: fund.quote });
  for (const value of [mergeFinancials(emptyFund, company)!, mergeFinancials(company, emptyFund)!]) {
    expect(value.quote?.instrumentType).toBe("ETF");
    expect(value.fundamentals).toBeUndefined();
    expect(value.profile).toBeUndefined();
  }
  expect(mergeFinancials(fund, company)?.profile?.description).toBe("Short Treasury bond fund");
  expect(mergeFinancials(company, null)?.fundamentals?.revenue).toBe(0);
  expect(sanitizeCachedFinancials({ ...fund, fundamentals: { dividendYield: 0 } }, { includeStaleQuotes: true }).fundamentals?.dividendYield).toBe(0);
  expect(sanitizeCachedFinancials({ ...fund, quote: { ...fund.quote!, instrumentType: "INDEX" } }, { includeStaleQuotes: true }).profile).toBeUndefined();
});

describe("AssetDataRouter cached financials", () => {
  test("drops stale cached cloud quotes while preserving cached cloud fundamentals", () => {
    const dbPath = createTempDbPath("stale-cloud-cached-financials");
    const persistence = new AppPersistence(dbPath);
    const now = Date.now();
    const previousSession = now - 24 * 60 * 60_000;

    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "HY9H",
        variantKey: "exchange=FWB2",
        sourceKey: "provider:gloomberb-cloud",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "HY9H",
          price: 528,
          currency: "EUR",
          change: 28,
          changePercent: 5.6,
          lastUpdated: previousSession,
          marketState: "REGULAR",
          exchangeName: "FWB2",
          listingExchangeName: "FWB2",
          providerId: "gloomberb-cloud",
          dataSource: "delayed",
        }),
        fundamentals: {
          revenue: 1234,
        },
        profile: {
          description: "Cloud profile",
        },
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
        fetchedAt: now,
      },
    );
    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "HY9H",
        variantKey: "exchange=FWB2",
        sourceKey: "provider:yahoo",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "HY9H.F",
          price: 596,
          currency: "EUR",
          change: 68,
          changePercent: 12.88,
          lastUpdated: now,
          marketState: "REGULAR",
          exchangeName: "FWB2",
          listingExchangeName: "FWB2",
          providerId: "yahoo",
          dataSource: "delayed",
        }),
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
        fetchedAt: now,
      },
    );

    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }, [{
      ...fallbackProvider,
      id: "gloomberb-cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }], persistence.resources);

    const cached = router.getCachedFinancialsForTargets([{
      symbol: "HY9H",
      exchange: "FWB2",
    }], { allowExpired: true });

    expect(cached.get("HY9H")?.quote?.providerId).toBe("yahoo");
    expect(cached.get("HY9H")?.quote?.price).toBe(596);
    expect(cached.get("HY9H")?.fundamentals?.revenue).toBe(1234);
    expect(cached.get("HY9H")?.profile?.description).toBe("Cloud profile");

    persistence.close();
  });

  test("drops cached premarket cloud quotes that lack an active-session price", () => {
    const dbPath = createTempDbPath("stale-cloud-premarket-cache");
    const persistence = new AppPersistence(dbPath);
    const now = Date.now();

    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "AMD",
        variantKey: "exchange=NASDAQ",
        sourceKey: "provider:gloomberb-cloud",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "AMD",
          price: 221.53,
          change: 1.35,
          changePercent: 0.61,
          lastUpdated: now,
          marketState: "PRE",
          exchangeName: "NASDAQ",
          listingExchangeName: "NASDAQ",
          providerId: "gloomberb-cloud",
          dataSource: "delayed",
        }),
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
        fetchedAt: now,
      },
    );
    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "AMD",
        variantKey: "exchange=NASDAQ",
        sourceKey: "provider:yahoo",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "AMD",
          price: 221.53,
          change: 1.35,
          changePercent: 0.61,
          lastUpdated: now,
          marketState: "PRE",
          preMarketPrice: 231,
          preMarketChange: 9.47,
          preMarketChangePercent: 4.27,
          exchangeName: "NASDAQ",
          listingExchangeName: "NASDAQ",
          providerId: "yahoo",
          dataSource: "delayed",
        }),
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
        fetchedAt: now,
      },
    );

    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }, [{
      ...fallbackProvider,
      id: "gloomberb-cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }], persistence.resources);

    const cached = router.getCachedFinancialsForTargets([{
      symbol: "AMD",
      exchange: "NASDAQ",
    }], { allowExpired: true });

    expect(cached.get("AMD")?.quote?.providerId).toBe("yahoo");
    expect(cached.get("AMD")?.quote?.preMarketPrice).toBe(231);

    persistence.close();
  });

  test("keeps stale cached quotes only for startup cache priming", () => {
    const dbPath = createTempDbPath("startup-stale-quote-prime");
    const persistence = new AppPersistence(dbPath);
    const now = Date.now();

    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "OLD",
        variantKey: "exchange=NASDAQ",
        sourceKey: "provider:gloomberb-cloud",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "OLD",
          price: 42,
          change: -1,
          changePercent: -2.33,
          lastUpdated: Date.UTC(2020, 0, 2),
          marketState: "REGULAR",
          exchangeName: "NASDAQ",
          listingExchangeName: "NASDAQ",
          providerId: "gloomberb-cloud",
          dataSource: "delayed",
        }),
        fundamentals: {
          trailingPE: 12,
        },
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
        fetchedAt: now,
      },
    );

    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "gloomberb-cloud",
      name: "Cloud",
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }, [], persistence.resources);

    const normal = router.getCachedFinancialsForTargets([{ symbol: "OLD", exchange: "NASDAQ" }], { allowExpired: true });
    expect(normal.get("OLD")?.quote).toBeUndefined();
    expect(normal.get("OLD")?.fundamentals?.trailingPE).toBe(12);

    const startup = router.getCachedFinancialsForTargets(
      [{ symbol: "OLD", exchange: "NASDAQ" }],
      { allowExpired: true, includeStaleQuotes: true },
    );
    expect(startup.get("OLD")?.quote?.changePercent).toBe(-2.33);
    expect(startup.get("OLD")?.fundamentals?.trailingPE).toBe(12);

    persistence.close();
  });

  test("does not fabricate market cap from an unverified shares basis", () => {
    const dbPath = createTempDbPath("cached-derived-market-cap");
    const persistence = new AppPersistence(dbPath);
    const now = Date.now();

    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "AMD",
        variantKey: "exchange=NASDAQ",
        sourceKey: "provider:gloomberb-cloud",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "AMD",
          price: 445.38,
          change: -2.91,
          changePercent: -0.65,
          lastUpdated: now,
          marketState: "REGULAR",
          exchangeName: "NASDAQ",
          listingExchangeName: "NASDAQ",
          providerId: "gloomberb-cloud",
          dataSource: "delayed",
        }),
        fundamentals: {
          sharesOutstanding: 1_630_000_000,
        },
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
        fetchedAt: now,
      },
    );

    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "gloomberb-cloud",
      name: "Cloud",
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }, [], persistence.resources);

    const cached = router.getCachedFinancialsForTargets([{ symbol: "AMD", exchange: "NASDAQ" }], {
      allowExpired: true,
      includeStaleQuotes: true,
    });
    expect(cached.get("AMD")?.quote?.marketCap).toBeUndefined();

    persistence.close();
  });

  test("uses symbol provider cache for broker-linked startup targets", () => {
    const dbPath = createTempDbPath("cached-symbol-fallback-for-contract");
    const persistence = new AppPersistence(dbPath);
    const now = Date.now();
    const old = now - 3 * 24 * 60 * 60_000;

    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "contract:14015423",
        variantKey: "exchange=JPX",
        sourceKey: "provider:yahoo",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "4092.T",
          providerId: "yahoo",
          price: 3770,
          currency: "JPY",
          change: 145,
          changePercent: 4,
          lastUpdated: old,
          marketState: "CLOSED",
          exchangeName: "JPX",
          listingExchangeName: "JPX",
        }),
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 7 * 24 * 60 * 60_000 },
        fetchedAt: old,
      },
    );
    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "4092.T",
        variantKey: "exchange=JPX",
        sourceKey: "provider:yahoo",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "4092.T",
          providerId: "yahoo",
          price: 3925,
          currency: "JPY",
          change: 20,
          changePercent: 0.51,
          lastUpdated: now,
          marketState: "CLOSED",
          exchangeName: "JPX",
          listingExchangeName: "JPX",
        }),
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 7 * 24 * 60 * 60_000 },
        fetchedAt: now,
      },
    );

    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }, [], persistence.resources);

    const cached = router.getCachedFinancialsForTargets([{
      symbol: "4092.T",
      exchange: "JPX",
      instrument: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-live",
        conId: 14015423,
        symbol: "4092.T",
      },
    }], { allowExpired: true, includeStaleQuotes: true });

    expect(cached.get("4092.T")?.quote?.price).toBe(3925);
    expect(cached.get("4092.T")?.quote?.changePercent).toBe(0.51);

    persistence.close();
  });

  test("uses symbol provider quote reference for broker-linked snapshot reads", async () => {
    const dbPath = createTempDbPath("cached-symbol-reference-for-contract-snapshot");
    const persistence = new AppPersistence(dbPath);
    const now = Date.now();

    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "contract:275759",
        variantKey: "exchange=NASDAQ",
        sourceKey: "provider:gloomberb-cloud",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "VICR",
          providerId: "gloomberb-cloud",
          price: 292.83,
          currency: "USD",
          previousClose: 380.07,
          change: -87.24,
          changePercent: -22.95,
          lastUpdated: now,
          marketState: "REGULAR",
          exchangeName: "NASDAQ",
          listingExchangeName: "NASDAQ",
          dataSource: "live",
        }),
        profile: {
          description: "Cloud profile",
        },
        fundamentals: {
          trailingPE: 94.3,
        },
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 7 * 24 * 60 * 60_000 },
        fetchedAt: now,
      },
    );
    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "contract:275759",
        variantKey: "exchange=NASDAQ",
        sourceKey: "provider:yahoo",
      },
      makeFinancials({
        annualStatements: [{ date: "2025-12-31", totalRevenue: 100 }],
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 7 * 24 * 60 * 60_000 },
        fetchedAt: now + 1_000,
      },
    );
    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "VICR",
        variantKey: "exchange=NASDAQ",
        sourceKey: "provider:yahoo",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "VICR",
          providerId: "yahoo",
          price: 294.39,
          currency: "USD",
          previousClose: 282.95,
          change: 11.44,
          changePercent: 4.04,
          lastUpdated: now - 1_000,
          marketState: "REGULAR",
          exchangeName: "NASDAQ",
          listingExchangeName: "NASDAQ",
          dataSource: "delayed",
        }),
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 7 * 24 * 60 * 60_000 },
        fetchedAt: now - 1_000,
      },
    );

    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }, [{
      ...fallbackProvider,
      id: "gloomberb-cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }], persistence.resources);

    const financials = await router.getTickerFinancials("VICR", "NASDAQ", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
      instrument: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
        conId: 275759,
        symbol: "VICR",
      },
    });

    expect(financials.quote?.providerId).toBe("gloomberb-cloud");
    expect(financials.quote?.price).toBe(292.83);
    expect(financials.quote?.previousClose).toBe(282.95);
    expect(financials.quote?.changePercent).toBeCloseTo(((292.83 - 282.95) / 282.95) * 100, 10);
    expect(financials.quote?.provenance?.fields?.previousClose?.providerId).toBe("yahoo");

    persistence.close();
  });

  test("overlays standalone quote cache on stale financial snapshots during startup priming", () => {
    const dbPath = createTempDbPath("cached-quote-over-financial-snapshot");
    const persistence = new AppPersistence(dbPath);
    const now = Date.parse("2026-05-13T21:00:00Z");
    const old = Date.parse("2026-05-09T14:13:30Z");

    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "contract:14016494",
        variantKey: "exchange=JPX",
        sourceKey: "provider:yahoo",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "6315.T",
          providerId: "yahoo",
          price: 3380,
          currency: "JPY",
          change: 75,
          changePercent: 2.27,
          lastUpdated: old,
          marketState: "CLOSED",
          exchangeName: "JPX",
          listingExchangeName: "JPX",
        }),
        fundamentals: {
          sharesOutstanding: 75_000_462,
          trailingPE: 37.2,
        },
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 7 * 24 * 60 * 60_000 },
        fetchedAt: old,
      },
    );
    persistence.resources.set(
      {
        namespace: "market",
        kind: "quote",
        entityKey: "contract:14016494",
        variantKey: "exchange=JPX",
        sourceKey: "provider:yahoo",
      },
      makeQuote({
        symbol: "6315.T",
        providerId: "yahoo",
        price: 2688,
        currency: "JPY",
        change: 13,
        changePercent: 0.49,
        lastUpdated: now,
        marketState: "CLOSED",
        exchangeName: "JPX",
        listingExchangeName: "JPX",
      }),
      {
        schemaVersion: 4,
        cachePolicy: { staleMs: 60_000, expireMs: 7 * 24 * 60 * 60_000 },
        fetchedAt: now,
      },
    );

    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async getTickerFinancials() {
        throw new Error("should not fetch financials");
      },
    }, [], persistence.resources);

    const cached = router.getCachedFinancialsForTargets([{
      symbol: "6315.T",
      exchange: "JPX",
      instrument: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-live",
        conId: 14016494,
        symbol: "6315.T",
      },
    }], { allowExpired: true, includeStaleQuotes: true });

    expect(cached.get("6315.T")?.quote?.price).toBe(2688);
    expect(cached.get("6315.T")?.quote?.changePercent).toBe(0.49);
    expect(cached.get("6315.T")?.quote?.marketCap).toBeUndefined();
    expect(cached.get("6315.T")?.fundamentals?.trailingPE).toBe(37.2);

    persistence.close();
  });
});
