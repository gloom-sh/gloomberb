import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import type { HistorySession, PriceHistoryResult } from "../../types/price-history";
import { AssetDataRouter } from "./index";
import { cleanupProviderRouterTestFiles, createTempDbPath, fallbackProvider } from "./test-support";

const PREOPEN = Date.parse("2026-09-22T12:42:12Z");
const start = new Date("2026-09-01T00:00:00Z");
const points = (time = "2026-09-21T19:45:00Z"): PricePoint[] => [
  { date: new Date(Date.parse(time) - 900_000), close: 338.125, volume: 101 },
  { date: new Date(time), close: 338.8900146484375, volume: 203 },
];
const session = (overrides: Partial<HistorySession> = {}): HistorySession => ({ version: 1, kind: "regular", calendar: "us-equity",
  timeZone: "America/New_York", symbol: "AAPL", exchange: "NASDAQ", interval: "15min", source: "yahoo",
  timestampConvention: "bar-open", barAlignment: "session-open", observedAt: PREOPEN, ...overrides });
const policy = { staleMs: 86_400_000, expireMs: 172_800_000 };
const read = (router: AssetDataRouter, end = new Date()) => router.getDetailedPriceHistoryWithMetadata("AAPL", "NASDAQ", start, end, "15m");
function provider(load: () => PriceHistoryResult, calls: string[], id = "gloomberb-cloud"): DataProvider {
  return { ...fallbackProvider, id, cachePolicy: { priceHistoryIntraday: policy },
    async getPriceHistoryWithMetadata() { calls.push("range"); return load(); },
    async getPriceHistoryForResolutionWithMetadata() { calls.push("resolution"); return load(); },
    async getDetailedPriceHistoryWithMetadata() { calls.push("detail"); return load(); },
  };
}
afterEach(() => { setSystemTime(); cleanupProviderRouterTestFiles(); });

test("regular history survives range, exact cadence and current detailed routes through persisted reopen with original acquisition metadata", async () => {
  setSystemTime(PREOPEN);
  const path = createTempDbPath("regular-reopen"), calls: string[] = [];
  let store = new AppPersistence(path);
  const acquired = { points: points(), resolution: "15m" as const, session: session(), sourceKey: "provider:spoofed" };
  const source = provider(() => acquired, calls);
  try {
    let router = new AssetDataRouter(source, [], store.resources);
    const requests = () => [router.getPriceHistoryWithMetadata("AAPL", "NASDAQ", "1M"),
      router.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", "15m"), read(router)];
    for (const value of await Promise.all(requests())) {
      expect(value.points).toEqual(acquired.points);
      expect(value.session).toEqual(acquired.session);
      expect(value.sourceKey).toBe("provider:gloomberb-cloud");
      expect(value.resolution).toBe("15m");
    }
    store.close(); store = new AppPersistence(path);
    router = new AssetDataRouter(source, [], store.resources);
    setSystemTime(PREOPEN + 60_000);
    // Use the same exact detailed window; a changed end is a distinct request.
    for (const value of await Promise.all([router.getPriceHistoryWithMetadata("AAPL", "NASDAQ", "1M"),
      router.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", "15m"), read(router, new Date(PREOPEN))])) {
      expect(JSON.stringify(value.points)).toBe(JSON.stringify(acquired.points));
      expect(value.session?.observedAt).toBe(PREOPEN);
      expect(value.sourceKey).toBe("provider:gloomberb-cloud");
    }
    expect(calls.sort()).toEqual(["detail", "range", "resolution"]);
    expect(JSON.stringify(await router.getPriceHistory("AAPL", "NASDAQ", "1M"))).toBe(JSON.stringify(acquired.points));
    expect(calls).toHaveLength(3);
    const records = store.resources.list({ namespace: "market", kind: "price-history", entityKey: "AAPL" });
    expect(records.every(record => record.variantKey.includes("historyData=1") && !Array.isArray(record.value))).toBe(true);
  } finally { store.close(); }
});

test("session completion and next due bar expire fresh cache records without relabeling old acquisition times", async () => {
  const calls: string[] = [];
  let acquired: PriceHistoryResult = { points: points(), resolution: "15m", session: session({ observedAt: Date.parse("2026-09-21T19:50:00Z") }) };
  const store = new AppPersistence(createTempDbPath("regular-boundaries"));
  const router = new AssetDataRouter(provider(() => acquired, calls), [], store.resources);
  const request = () => router.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", "15m").catch(() => ({ points: [] }));
  try {
    setSystemTime(new Date("2026-09-21T19:50:00Z"));
    expect((await request()).points).toHaveLength(2);
    setSystemTime(new Date("2026-09-21T20:16:00Z"));
    expect((await request()).points).toHaveLength(0);
    expect(calls).toHaveLength(2);
    acquired = { ...acquired, session: session({ observedAt: Date.now() }) };
    expect((await request()).points).toHaveLength(2);
    setSystemTime(new Date("2026-09-22T13:59:59Z"));
    expect((await request()).points).toHaveLength(2);
    expect(calls).toHaveLength(3);
    setSystemTime(new Date("2026-09-22T14:00:00Z"));
    expect((await request()).points).toHaveLength(0);
    expect(calls).toHaveLength(4);
    acquired = { points: points("2026-09-22T13:30:00Z"), resolution: "15m", session: session({ observedAt: Date.now() }) };
    expect((await request()).points).toHaveLength(2);
    expect(calls).toHaveLength(5);
  } finally { store.close(); }
});

test("legacy arrays, foreign assets and contradictory session records cannot borrow regular equity freshness", async () => {
  setSystemTime(PREOPEN);
  for (const [symbol, exchange, metadata] of [
    ["AAPL", "NASDAQ", undefined], ["AAPL", "NASDAQ", session({ symbol: "MSFT" })],
    ["AAPL", "NASDAQ", session({ interval: "5min" })], ["AAPL", "NASDAQ", session({ exchange: "NYSE" })],
    ["BTC-USD", "CCC", session()], ["EURUSD=X", "CCY", session()], ["VOD.L", "LSE", session()],
  ] as const) {
    const calls: string[] = [], store = new AppPersistence(createTempDbPath("regular-unknown"));
    try {
      const variant = "exchange=" + exchange + ";range=1M;resolution=15m;version=5";
      store.resources.set({ namespace: "market", kind: "price-history", entityKey: symbol, variantKey: variant, sourceKey: "provider:gloomberb-cloud" }, points("2026-09-18T19:45:00Z"), { cachePolicy: policy });
      const router = new AssetDataRouter(provider(() => ({ points: points(), resolution: "15m", session: metadata }), calls), [], store.resources);
      await expect(router.getPriceHistoryForResolutionWithMetadata(symbol, exchange, "1M", "15m")).rejects.toThrow();
      expect(calls).toEqual(["resolution"]);
      const historical = await router.getDetailedPriceHistoryWithMetadata(symbol, exchange, start, new Date("2026-09-21T20:00:00Z"), "15m");
      expect(historical.points).toEqual(metadata ? [] : points());
      expect(historical.session).toBeUndefined();
    } finally { store.close(); }
  }
});

test("source switching and broker contract fallback never transplant an equity session from another acquisition", async () => {
  setSystemTime(PREOPEN);
  const calls: string[] = [], store = new AppPersistence(createTempDbPath("regular-source"));
  try {
    const proof = { points: points(), resolution: "15m" as const, session: session() };
    const first = new AssetDataRouter(provider(() => proof, calls, "first"), [], store.resources);
    expect((await read(first)).session).toEqual(proof.session);
    const second = new AssetDataRouter(provider(() => ({ points: points(), resolution: "15m" }), calls, "second"), [], store.resources);
    expect((await read(second)).points).toHaveLength(0);
    const brokerFallback = new AssetDataRouter(provider(() => proof, calls, "first"), [], store.resources);
    expect((await brokerFallback.getDetailedPriceHistoryWithMetadata("AAPL", "NASDAQ", start, new Date(), "15m", {
      instrument: { brokerId: "ibkr", symbol: "AAPL", secType: "OPT", conId: 17 },
    })).points).toHaveLength(0);
    expect(calls).toEqual(["detail", "detail", "detail"]);
  } finally { store.close(); }
});

test("reported gaps keep the selected usable history's source/session while metadata-only methods retain traversal support", async () => {
  setSystemTime(PREOPEN);
  const gaps = [{ date: new Date("2026-09-21T19:40:00Z"), close: null }] as PricePoint[];
  const calls: string[] = [];
  const router = new AssetDataRouter(provider(() => ({ points: points(), resolution: "15m", session: session() }), calls, "actual"),
    [provider(() => ({ points: gaps, resolution: "15m" }), calls, "missing")]);
  const result = await read(router);
  expect(result.points).toEqual([points()[0]!, ...gaps, points()[1]!]);
  expect(result.sourceKey).toBe("provider:actual");
  expect(result.session).toEqual(session());
  expect(calls).toEqual(["detail", "detail"]);
});
