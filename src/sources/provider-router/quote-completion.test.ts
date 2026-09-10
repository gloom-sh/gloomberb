import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider } from "../../types/data-provider";
import { AssetDataRouter } from "./index";
import { cleanupProviderRouterTestFiles, createTempDbPath, fallbackProvider, makeFinancials, makeQuote } from "./test-support";

afterEach(cleanupProviderRouterTestFiles);

test.each(["single", "batch"] as const)("%s financials recover a stale embedded Tokyo quote through the quote route", async (route) => {
  const persistence = new AppPersistence(createTempDbPath(`tokyo-quote-${route}`));
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-09-10T21:50:00Z");
  const calls = { financials: 0, fallbackFinancials: 0, fallbackQuote: 0 };
  const staleQuote = makeQuote({ symbol: "7203", price: 2980.5, currency: "JPY", change: 9.5,
    changePercent: 0.31975765735442613, previousClose: 2971, stale: true,
    lastUpdated: Date.parse("2026-09-10T06:24:00Z"), exchangeName: "TYO",
    providerId: "gloomberb-cloud", dataSource: "delayed", marketState: "PRE" });
  const snapshot = makeFinancials({ quote: staleQuote, profile: { description: "Toyota Motor Corporation" },
    annualStatements: Array.from({ length: 5 }, (_, i) => ({ date: `${2022 + i}-03-31`, currency: "JPY", totalRevenue: 100 + i, inventory: 10 })),
  });
  const cloud: DataProvider = {
    ...fallbackProvider, id: "gloomberb-cloud", priority: 100,
    async getTickerFinancials() { calls.financials++; return snapshot; },
    async getTickerFinancialsBatch(targets) { calls.financials++; return targets.map((target) => ({ target, financials: snapshot })); },
    async getQuote() { return staleQuote; },
  };
  let quoteFails = false;
  const yahoo: DataProvider = {
    ...fallbackProvider, id: "yahoo", priority: 1000,
    async getTickerFinancials() { calls.fallbackFinancials++; throw new Error("No supplemental statements"); },
    async getQuote(symbol, exchange) {
      calls.fallbackQuote++;
      expect([symbol, exchange]).toEqual(["7203", "TYO"]);
      if (quoteFails) throw new Error("Quote unavailable");
      return makeQuote({ symbol, price: 2994, currency: "JPY", change: 23,
        changePercent: 0.7741501178054527, lastUpdated: Date.parse("2026-09-10T06:30:00Z"),
        exchangeName: "TYO", providerId: "yahoo", marketState: "PRE" });
    },
  };
  const router = new AssetDataRouter(yahoo, [cloud], persistence.resources);
  const load = async () => route === "single"
    ? router.getTickerFinancials("7203", "TYO")
    : (await router.getTickerFinancialsBatch([{ symbol: "7203", exchange: "TYO" }]))[0]!.financials!;
  try {
    const result = await load();
    expect(result.quote).toMatchObject({ price: 2994, currency: "JPY", change: 23, providerId: "yahoo" });
    expect(result.annualStatements).toEqual(snapshot.annualStatements);
    expect(calls).toEqual({ financials: 1, fallbackFinancials: 0, fallbackQuote: 1 });
    expect((await load()).quote?.price).toBe(2994);
    expect(calls.fallbackQuote).toBe(1);

    // Historical research remains usable when every current quote source fails.
    quoteFails = true;
    const withoutCache = new AssetDataRouter(yahoo, [cloud]);
    const historical = await withoutCache.getTickerFinancials("7203", "TYO");
    expect(historical.quote).toBeUndefined();
    expect(historical.annualStatements).toEqual(snapshot.annualStatements);
  } finally {
    Date.now = originalNow;
    persistence.close();
  }
});
