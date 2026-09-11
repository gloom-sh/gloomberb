import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { AssetDataRouter } from "./index";
import { cleanupProviderRouterTestFiles, createTempDbPath, fallbackProvider } from "./test-support";

afterEach(cleanupProviderRouterTestFiles);
const bad = [{ date: new Date("2013-03-25"), close: .55227 }];
const good = [{ date: new Date("2022-05-02"), close: 49.21 }, { date: new Date("2026-08-24"), close: 59.87 }];
const equalHistory = (value: unknown) => expect(JSON.stringify(value)).toBe(JSON.stringify(good));
const policy = { staleMs: 60_000, expireMs: 600_000 };

test("saved JEPQ range, broader-window and detailed caches cannot retain pre-inception rows", async () => {
  for (const ticker of ["JEPQ", "JEPQ:XNAS"]) {
    const store = new AppPersistence(createTempDbPath("jepq-boundary"));
    try {
      for (const [kind, variantKey] of [
        ["price-history", "exchange=NASDAQ;range=ALL;version=4;granularity=1"],
        ["price-history", "exchange=NASDAQ;range=ALL;resolution=1wk;version=4;granularity=1"],
        ["price-history", "range=ALL;resolution=1wk;version=4;granularity=1"],
        ["detailed-price-history", "exchange=NASDAQ;start=2000-01-01;end=2026-08-31;bar=1wk;version=4"],
      ]) store.resources.set({ namespace: "market", kind: kind!, entityKey: ticker, variantKey, sourceKey: "provider:gloomberb-cloud" }, bad, { cachePolicy: policy });
      let calls = 0;
      const load = async () => { calls++; return good; };
      const provider = { ...fallbackProvider, id: "gloomberb-cloud", getPriceHistory: load, getPriceHistoryForResolution: load, getDetailedPriceHistory: load };
      const read = async (router: AssetDataRouter) => {
        equalHistory(await router.getPriceHistory(ticker, "NASDAQ", "ALL"));
        equalHistory(await router.getPriceHistoryForResolution(ticker, "NASDAQ", "5Y", "1wk"));
        equalHistory(await router.getDetailedPriceHistory(ticker, "NASDAQ", new Date("2000-01-01"), new Date("2026-08-31"), "1wk"));
      };
      await read(new AssetDataRouter(provider, [], store.resources));
      expect(calls).toBe(3);
      // A new router models restart: the corrected records, including serialized
      // dates, are reusable; old broader variants still cannot win selection.
      await read(new AssetDataRouter(provider, [], store.resources));
      expect(calls).toBe(3);
    } finally { store.close(); }
  }
});

test("source failure cannot resurrect old JEPQ cache, while an unrelated verified-cadence weekly cache remains usable", async () => {
  const store = new AppPersistence(createTempDbPath("jepq-boundary-miss"));
  try {
    for (const ticker of ["JEPQ", "QQQ"]) store.resources.set({ namespace: "market", kind: "price-history", entityKey: ticker, variantKey: "exchange=NASDAQ;range=ALL;resolution=1wk;version=4;granularity=1", sourceKey: "provider:gloomberb-cloud" }, ticker === "JEPQ" ? bad : good, { cachePolicy: policy });
    const requested: string[] = [];
    const router = new AssetDataRouter({ ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistoryForResolution(ticker) { requested.push(ticker); return []; } }, [], store.resources);
    expect(await router.getPriceHistoryForResolution("JEPQ", "NASDAQ", "ALL", "1wk")).toEqual([]);
    equalHistory(await router.getPriceHistoryForResolution("QQQ", "NASDAQ", "ALL", "1wk"));
    expect(requested).toEqual(["JEPQ"]);
  } finally { store.close(); }
});

test("monthly cache is refreshed independently of unaffected daily and weekly variants", async () => {
  const store = new AppPersistence(createTempDbPath("monthly-calendar-cache"));
  try {
    for (const resolution of ["1mo", "1wk", "1d"]) store.resources.set({ namespace: "market", kind: "price-history", entityKey: "QQQ", variantKey: `exchange=NASDAQ;range=ALL;resolution=${resolution};version=4;granularity=1`, sourceKey: "provider:gloomberb-cloud" }, good, { cachePolicy: policy });
    const resolutions: string[] = [];
    const router = new AssetDataRouter({ ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistoryForResolution(_ticker, _exchange, _range, resolution) { resolutions.push(resolution); return good; } }, [], store.resources);
    for (const resolution of ["1mo", "1wk", "1d"] as const) await router.getPriceHistoryForResolution("QQQ", "NASDAQ", "ALL", resolution);
    expect(resolutions).toEqual(["1mo"]);
  } finally { store.close(); }
});

test("the inception repair leaves historical JEPQ intraday caches reusable", async () => {
  const store = new AppPersistence(createTempDbPath("jepq-intraday-control"));
  try {
    store.resources.set({ namespace: "market", kind: "detailed-price-history", entityKey: "JEPQ", variantKey: "exchange=NASDAQ;start=2026-08-01;end=2026-08-31;bar=1h;version=4", sourceKey: "provider:gloomberb-cloud" }, good, { cachePolicy: policy });
    let calls = 0;
    const router = new AssetDataRouter({ ...fallbackProvider, id: "gloomberb-cloud", async getDetailedPriceHistory() { calls++; return []; } }, [], store.resources);
    equalHistory(await router.getDetailedPriceHistory("JEPQ", "NASDAQ", new Date("2026-08-01"), new Date("2026-08-31"), "1h"));
    expect(calls).toBe(0);
  } finally { store.close(); }
});
