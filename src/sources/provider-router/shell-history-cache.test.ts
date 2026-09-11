import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { BrokerAdapter } from "../../types/broker";
import type { PricePoint } from "../../types/financials";
import { AssetDataRouter } from "./index";
import { cacheRouterResource } from "./cache";
import { attachTestRegistry, brokerInstance, cleanupProviderRouterTestFiles, createTempDbPath, fallbackProvider, makeFinancials, makeQuote, setBrokerInstances } from "./test-support";

afterEach(cleanupProviderRouterTestFiles);
const policy = { staleMs: 60_000, expireMs: 600_000 };
const bad = [{ date: new Date("1997-06-30"), close: 63.8935986328125 }, { date: new Date("2026-09-07"), close: 35.33 }];
const good: PricePoint[] = [{ date: new Date("2005-07-25"), close: 17.47 }, { date: new Date("2026-09-07"), close: 35.33 }]
  .map((point) => ({ ...point, historySource: { provider: "yahoo", symbol: "SHEL", exchange: "LSE", currency: "GBP", verifiedLineageStart: "2005-07-21" } }));
const equal = (actual: unknown, expected: unknown) => expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));

test("saved Shell source caches recover across range, broader and detailed paths and a new router", async () => {
  for (const [id, origin] of [["yahoo", "yahoo"], ["gloomberb-cloud", "yahoo"], ["gloomberb-cloud", "twelvedata"]] as const) for (const ticker of ["SHEL", "SHEL:XLON"]) {
    const store = new AppPersistence(createTempDbPath("shell-lineage"));
    // 242 cloud records included unrestricted Twelve provenance. They must not
    // bypass the same recovery merely because a provider was already recorded.
    const legacy = origin === "twelvedata" ? bad.map((point) => ({ ...point, historySource: {
      provider: origin, symbol: "SHEL", exchange: "LSE", currency: "GBP",
    } })) : bad;
    const corrected = good.map((point) => ({ ...point, historySource: { ...point.historySource!, provider: origin } }));
    try {
      for (const [kind, variantKey] of [
        ["price-history", "exchange=LSE;range=ALL;version=4;calendar=1;unit=GBP"],
        ["price-history", "exchange=LSE;range=ALL;resolution=1wk;version=4;unit=GBP"],
        ["price-history", "range=ALL;resolution=1wk;version=4;unit=GBP"],
        ["detailed-price-history", "exchange=LSE;start=1996-01-01;end=2026-09-10;bar=1wk;version=4;unit=GBP"],
      ]) store.resources.set({ namespace: "market", kind: kind!, entityKey: ticker, variantKey, sourceKey: `provider:${id}` }, legacy, { cachePolicy: policy });
      let calls = 0;
      const load = async () => { calls++; return corrected; };
      const provider = { ...fallbackProvider, id, getPriceHistory: load, getPriceHistoryForResolution: load, getDetailedPriceHistory: load };
      const read = async (router: AssetDataRouter) => {
        equal(await router.getPriceHistory(ticker, "LSE", "ALL"), corrected);
        equal(await router.getPriceHistoryForResolution(ticker, "LSE", "5Y", "1wk"), corrected);
        equal(await router.getDetailedPriceHistory(ticker, "LSE", new Date("1996-01-01"), new Date("2026-09-10"), "1wk"), corrected);
      };
      await read(new AssetDataRouter(provider, [], store.resources));
      expect(calls).toBe(3);
      await read(new AssetDataRouter(provider, [], store.resources));
      expect(calls).toBe(3);
    } finally { store.close(); }
  }
});

test("an unavailable or legacy provider response cannot revive poisoned cache; valid independent history still wins", async () => {
  const store = new AppPersistence(createTempDbPath("shell-lineage-fallback"));
  try {
    const key = { namespace: "market", kind: "price-history", entityKey: "SHEL", variantKey: "exchange=LSE;range=ALL;resolution=1wk;version=4;unit=GBP" };
    store.resources.set({ ...key, sourceKey: "provider:gloomberb-cloud" }, bad, { cachePolicy: policy });
    for (const [index, load] of [async () => [], async () => bad, async () => { throw Error("controlled offline source"); }].entries()) {
      const router = new AssetDataRouter({ ...fallbackProvider, id: "gloomberb-cloud", getPriceHistoryForResolution: load }, [], store.resources);
      if (index === 0) expect(await router.getPriceHistoryForResolution("SHEL", "LSE", "ALL", "1wk")).toEqual([]);
      else await expect(router.getPriceHistoryForResolution("SHEL", "LSE", "ALL", "1wk")).rejects.toThrow("No resolution-aware history provider");
    }
    const independent = bad;
    store.resources.set({ ...key, sourceKey: "provider:independent" }, independent, { cachePolicy: policy });
    const router = new AssetDataRouter({ ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistoryForResolution() { return []; } },
      [{ ...fallbackProvider, id: "independent", async getPriceHistoryForResolution() { throw Error("should reuse independent cache"); } }], store.resources);
    equal(await router.getPriceHistoryForResolution("SHEL", "LSE", "ALL", "1wk"), independent);
  } finally { store.close(); }
});

test("modern London, US and Amsterdam histories and broker history are not retired", async () => {
  const store = new AppPersistence(createTempDbPath("shell-lineage-controls"));
  try {
    const modern = [bad[1]!];
    for (const [ticker, exchange, points] of [["SHEL", "LSE", modern], ["SHEL", "NYSE", bad], ["SHELL", "AMS", bad]] as const) {
      const unit = exchange === "LSE" ? ";unit=GBP" : "";
      store.resources.set({ namespace: "market", kind: "price-history", entityKey: ticker,
        variantKey: `exchange=${exchange};range=1Y;resolution=1wk;version=4${unit}`, sourceKey: "provider:yahoo" }, points, { cachePolicy: policy });
      const router = new AssetDataRouter({ ...fallbackProvider, id: "yahoo", async getPriceHistoryForResolution() { throw Error("unchanged cache should be reused"); } }, [], store.resources);
      equal(await router.getPriceHistoryForResolution(ticker, exchange, "1Y", "1wk"), points);
    }
    const broker: BrokerAdapter = { id: "ibkr", name: "IBKR", configSchema: [], async validate() { return true; }, async importPositions() { return []; } };
    store.resources.set({ namespace: "market", kind: "price-history", entityKey: "SHEL", variantKey: "exchange=LSE;range=ALL;resolution=1wk;version=4;unit=GBP", sourceKey: "broker:ibkr:ibkr-work" }, bad, { cachePolicy: policy });
    const router = new AssetDataRouter(fallbackProvider, [], store.resources);
    attachTestRegistry(router, { brokers: [["ibkr", broker]] }); setBrokerInstances(router, [brokerInstance()]);
    equal(await router.getPriceHistoryForResolution("SHEL", "LSE", "ALL", "1wk", { brokerId: "ibkr", brokerInstanceId: "ibkr-work" }), bad);
  } finally { store.close(); }
});

test("legacy financial snapshots lose affected history while valid accounts and broker contributions survive", async () => {
  for (const [id, origin] of [["yahoo", "yahoo"], ["gloomberb-cloud", "yahoo"], ["gloomberb-cloud", "twelvedata"]] as const) {
    const store = new AppPersistence(createTempDbPath("shell-financial-history"));
    try {
      const legacy = origin === "twelvedata" ? bad.map((point) => ({ ...point, historySource: { provider: origin, symbol: "SHEL" as const, exchange: "LSE" as const, currency: "GBP" as const } })) : bad;
      const financials = makeFinancials({ quote: makeQuote({ symbol: "SHEL", currency: "GBP", listingExchangeName: "LSE", providerId: id }),
        profile: { description: "Recorded research fixture" }, annualStatements: [{ date: "2025-12-31", totalRevenue: 100 }], priceHistory: legacy });
      cacheRouterResource(store.resources, "financials", "SHEL", "exchange=LSE", `provider:${id}`, financials, policy);
      const provider = { ...fallbackProvider, id, async getTickerFinancials() { return financials; } };
      const router = new AssetDataRouter(provider, [], store.resources);
      const value = await router.getTickerFinancials("SHEL", "LSE");
      expect(value.priceHistory).toEqual([]);
      expect(value.annualStatements).toEqual(financials.annualStatements);
      expect(value.profile).toEqual(financials.profile);
      // An extended partial refresh merges its previous source record first;
      // that branch must not resurrect the same stale snapshot history.
      const extended = await router.getTickerFinancials("SHEL", "LSE", { statementHistory: "extended", cacheMode: "refresh" });
      expect(extended.priceHistory).toEqual([]);
      const broker: BrokerAdapter = { id: "ibkr", name: "IBKR", configSchema: [], async validate() { return true; }, async importPositions() { return []; } };
      cacheRouterResource(store.resources, "financials", "SHEL", "exchange=LSE", "broker:ibkr:ibkr-work", { ...financials, quote: { ...financials.quote!, providerId: "ibkr" } }, policy);
      attachTestRegistry(router, { brokers: [["ibkr", broker]] }); setBrokerInstances(router, [brokerInstance()]);
      equal((await router.getTickerFinancials("SHEL", "LSE", { brokerId: "ibkr", brokerInstanceId: "ibkr-work" })).priceHistory, legacy);
    } finally { store.close(); }
  }
});


test("safe old filtered caches recover missing disclosure only for requested long windows", async () => {
  for (const origin of ["yahoo", "twelvedata"] as const) {
    const store = new AppPersistence(createTempDbPath("shell-lineage-missing-provenance"));
    const legacy = good.map(({ historySource, ...point }) => point);
    const corrected = good.map((point) => ({ ...point, historySource: { ...point.historySource!, provider: origin } }));
    try {
      store.resources.set({ namespace: "market", kind: "price-history", entityKey: "SHEL",
        variantKey: "exchange=LSE;range=ALL;resolution=1wk;version=4;unit=GBP", sourceKey: "provider:gloomberb-cloud" }, legacy, { cachePolicy: policy });
      let calls = 0;
      const provider = { ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistoryForResolution() { calls++; return corrected; } };
      const router = new AssetDataRouter(provider, [], store.resources);
      equal(await router.getPriceHistoryForResolution("SHEL", "LSE", "1Y", "1wk"), [legacy[1]]);
      expect(calls).toBe(0);
      equal(await router.getPriceHistoryForResolution("SHEL", "LSE", "ALL", "1wk"), corrected);
      expect(calls).toBe(1);
      equal(await new AssetDataRouter(provider, [], store.resources).getPriceHistoryForResolution("SHEL", "LSE", "ALL", "1wk"), corrected);
      expect(calls).toBe(1);
    } finally { store.close(); }
  }
});
