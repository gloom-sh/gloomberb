import { afterEach, expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { MarketDataCoordinator } from "../../market-data/coordinator";
import { createDailyNavQuote } from "../../test-support/daily-nav";
import { createTestDataProvider, createTestFinancials } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";
import { AssetDataRouter } from "./index";

afterEach(removeTempDbFiles);

test("daily NAV source date survives financials disk cache and coordinator quote reconciliation", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-08T07:59:59.999Z"));
  const quote = createDailyNavQuote({ providerId: "gloomberb-cloud" });
  const financials = createTestFinancials({ quote });
  let fetches = 0;
  const provider = createTestDataProvider({ id: "gloomberb-cloud",
    getTickerFinancials: async () => { fetches++; return financials; }, getQuote: async () => quote });
  const path = createTempDbPath("daily-nav-cache");
  let persistence = new AppPersistence(path);
  let coordinator: MarketDataCoordinator | undefined;
  try {
    const target = { symbol: "VFIAX", exchange: "NASDAQ" };
    const loaded = await new AssetDataRouter(provider, [], persistence.resources).getTickerFinancials(target.symbol, target.exchange);
    expect(loaded.quote).toMatchObject({ priceObservation: "nav", changeSessionDate: "2026-10-06", lastUpdated: quote.lastUpdated });
    persistence.close();
    persistence = new AppPersistence(path);
    const router = new AssetDataRouter(provider, [], persistence.resources);
    const cached = router.getCachedFinancialsForTargets([target]).get(target.symbol)!;
    expect(cached.quoteContributions?.[provider.id]).toMatchObject({ priceObservation: "nav", changeSessionDate: "2026-10-06" });
    coordinator = new MarketDataCoordinator(router);
    coordinator.primeCachedFinancials([{ instrument: target, financials: cached }]);
    await coordinator.loadQuote(target);
    for (const value of [coordinator.getQuoteEntry(target).data, coordinator.getTickerFinancialsSync(target)?.quote]) {
      expect(value).toMatchObject({ priceObservation: "nav", priceBasis: "per-unit", changeSessionDate: "2026-10-06",
        lastUpdated: quote.lastUpdated, price: 721.63, previousClose: 718.5 });
      expect(value?.marketState).toBeUndefined();
      expect(value?.change).toBeCloseTo(3.13);
    }
    expect(fetches).toBe(1);
    // The resource is only a millisecond old; its TTL cannot extend the NAV.
    clock.mockReturnValue(Date.parse("2026-10-08T08:00:00Z"));
    expect(router.getCachedFinancialsForTargets([target]).get(target.symbol)?.quote).toBeUndefined();
    expect(router.getCachedFinancialsForTargets([target], { includeStaleQuotes: true }).get(target.symbol)?.quote)
      .toMatchObject({ priceObservation: "nav", changeSessionDate: "2026-10-06", lastUpdated: quote.lastUpdated });
  } finally {
    coordinator?.destroy();
    persistence.close();
    clock.mockRestore();
  }
});
