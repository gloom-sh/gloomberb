import { expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { Quote } from "../../types/financials";
import { isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { AssetDataRouter } from "./index";
import { attachTestRegistry, brokerInstance, fallbackProvider, makeFinancials, setBrokerInstances } from "./test-support";

test("broker price and provider session survive scalar, batch and cached financials composition", async () => {
  for (const [time, marketState] of [["2026-04-08T11:00:00Z", "PRE"], ["2026-04-08T22:00:00Z", "POST"]] as const) {
    const now = Date.parse(time);
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const store = new AppPersistence(":memory:");
    try {
      const brokerQuote: Quote = { symbol: "AMD", providerId: "ibkr", dataSource: "live", price: 100.25,
        currency: "USD", change: 1, changePercent: 1, lastUpdated: now - 60_000,
        listingExchangeName: "NASDAQ", routingExchangeName: "SMART", sessionConfidence: "unknown" };
      const yahoo: Quote = { ...brokerQuote, providerId: "yahoo", dataSource: "delayed", price: 99.7,
        lastUpdated: now - 180_000, routingExchangeName: undefined, marketState, sessionConfidence: "derived",
        ...(marketState === "PRE" ? { preMarketPrice: 101 } : { postMarketPrice: 102 }) };
      let brokerCalls = 0;
      const router = new AssetDataRouter({ ...fallbackProvider, id: "yahoo",
        getQuote: async () => yahoo, getTickerFinancials: async () => makeFinancials({ quote: yahoo }) }, [], store.resources);
      attachTestRegistry(router, { brokers: [["ibkr", {
        id: "ibkr", name: "Test broker", configSchema: [], validate: async () => true, importPositions: async () => [],
        getQuote: async () => { brokerCalls += 1; return brokerQuote; },
        getTickerFinancials: async () => makeFinancials({ quote: { ...brokerQuote, price: 100 } }),
      }]] });
      setBrokerInstances(router, [brokerInstance()]);
      const context = { brokerId: "ibkr", brokerInstanceId: "ibkr-work" };
      const target = { symbol: "AMD", exchange: "NASDAQ", ...context };
      function expectComposed(quote: Quote | undefined | null, price: number) {
        expect(quote).toMatchObject({ price, lastUpdated: brokerQuote.lastUpdated, marketState, routingExchangeName: "SMART" });
        expect(quote?.provenance).toMatchObject({ price: { providerId: "ibkr" }, session: { providerId: "yahoo" } });
        expect(isQuoteStaleForCurrentSession(quote, now)).toBe(false);
      }
      expectComposed((await router.getTickerFinancials("AMD", "NASDAQ", context)).quote, 100);
      expectComposed(router.getCachedFinancialsForTargets([target]).get("AMD")?.quote, 100);
      expectComposed(await router.getQuote("AMD", "NASDAQ", context), 100.25);
      expectComposed(await router.getQuote("AMD", "NASDAQ", context), 100.25);
      expectComposed((await router.getQuotesBatch([{ symbol: "AMD", exchange: "NASDAQ", context }]))[0]?.quote, 100.25);
      expect(brokerCalls).toBe(1);
      expectComposed(router.getCachedFinancialsForTargets([target]).get("AMD")?.quote, 100.25);
      brokerQuote.stale = true;
      store.resources.set({ namespace: "market", kind: "quote", entityKey: "AMD", variantKey: "exchange=NASDAQ", sourceKey: "broker:ibkr:ibkr-work" }, brokerQuote,
        { schemaVersion: 1, cachePolicy: { staleMs: 60_000, expireMs: 60_000 }, fetchedAt: now });
      expect((await router.getQuote("AMD", "NASDAQ", context)).price).toBe(99.7);
    } finally {
      store.close();
      clock.mockRestore();
    }
  }
});
