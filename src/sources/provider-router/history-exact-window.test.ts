import { afterEach, expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import { AssetDataRouter } from "./index";
import { attachTestRegistry, brokerInstance, setBrokerInstances } from "./test-support";
import { fallbackProvider } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

afterEach(removeTempDbFiles);
const start = new Date("2026-09-21T09:00:00Z");
const end = new Date("2026-09-21T10:00:00Z");
const laterStart = new Date("2026-09-21T09:30:00Z");
const laterEnd = new Date("2026-09-21T10:30:00Z");
const policy = { staleMs: 60_000, expireMs: 600_000 };
const rows = (from: Date, to: Date, offset = 0): PricePoint[] => Array.from(
  { length: Math.floor((+to - +from) / 900_000) + 1 },
  (_, i) => ({ date: new Date(+from + i * 900_000), close: 100 + (+from % 86_400_000) / 900_000 + i + offset }),
);
const sameRows = (actual: PricePoint[], expected: PricePoint[]) => expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
const read = (router: AssetDataRouter, from = start, to = end, bar = "15m", context?: MarketDataRequestContext) =>
  router.getDetailedPriceHistory("BTC-USD", "CCC", from, to, bar, context);
function source(calls: string[], id = "window-test", offset = 0): DataProvider {
  return { ...fallbackProvider, id, async getDetailedPriceHistory(_ticker, _exchange, from, to, bar) {
    calls.push(`${from.toISOString()}|${to.toISOString()}|${bar}`);
    return rows(from, to, offset);
  } };
}

test("exact intraday endpoints survive persisted reopen and refresh without overwriting neighboring windows", async () => {
  const path = createTempDbPath("exact-history-reopen"), calls: string[] = [];
  let store = new AppPersistence(path);
  const provider = source(calls);
  const windows = [[start, end], [laterStart, end], [start, laterEnd]] as const;
  try {
    let router = new AssetDataRouter(provider, [], store.resources);
    for (const [from, to] of windows) sameRows(await read(router, from, to), rows(from, to));
    expect(calls).toHaveLength(3);
    store.close(); store = new AppPersistence(path);
    router = new AssetDataRouter(provider, [], store.resources);
    for (const [from, to] of windows) sameRows(await read(router, from, to), rows(from, to));
    expect(calls).toHaveLength(3);
    sameRows(await read(router, start, laterEnd, "15m", { cacheMode: "refresh" }), rows(start, laterEnd));
    sameRows(await read(router), rows(start, end));
    sameRows(await read(router, laterStart), rows(laterStart, end));
    expect(calls).toHaveLength(4);
  } finally { store.close(); }
});

test("calendar daily and weekly caches keep their established date-only normalization", async () => {
  const store = new AppPersistence(createTempDbPath("exact-history-calendar"));
  const cached = [{ date: new Date("2026-09-21"), close: 100 }];
  try {
    for (const bar of ["1d", "1day", "1wk", "1week"]) store.resources.set({ namespace: "market", kind: "detailed-price-history", entityKey: "BTC-USD",
      variantKey: `exchange=CCC;start=2026-09-21;end=2026-09-21;bar=${bar};version=6`, sourceKey: "provider:window-test" },
    { points: cached, resolution: bar.startsWith("1d") ? "1d" : "1wk" }, { cachePolicy: policy });
    const calls: string[] = [], router = new AssetDataRouter(source(calls), [], store.resources);
    for (const bar of ["1d", "1day", "1wk", "1week"]) {
      sameRows(await read(router, start, end, bar), cached);
      sameRows(await read(router, laterStart, laterEnd, bar), cached);
    }
    expect(calls).toHaveLength(0);
  } finally { store.close(); }
});

test("hour units spanning a day and unknown intervals retain timestamp bounds", async () => {
  const store = new AppPersistence(createTempDbPath("exact-history-noncalendar")), calls: string[] = [];
  try {
    const router = new AssetDataRouter(source(calls), [], store.resources);
    // These controlled arrays test request identity, not interval resampling.
    for (const bar of ["24h", "48h", "1hour", "custom-interval"]) {
      sameRows(await read(router, start, end, bar), rows(start, end));
      sameRows(await read(router, laterStart, end, bar), rows(laterStart, end));
      sameRows(await read(router, start, laterEnd, bar), rows(start, laterEnd));
    }
    expect(calls).toHaveLength(12);
  } finally { store.close(); }
});

test("stale background refresh deduplicates the same exact window while refreshing distinct bounds", async () => {
  let now = Date.parse("2026-09-22T12:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const store = new AppPersistence(createTempDbPath("exact-history-revalidation"));
  let hold = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const provider: DataProvider = { ...fallbackProvider, id: "window-test", cachePolicy: { priceHistoryIntraday: { staleMs: 100, expireMs: 60_000 } },
    async getDetailedPriceHistory(_ticker, _exchange, from, to) {
      calls.push(`${from.toISOString()}|${to.toISOString()}`);
      if (hold) await gate;
      return rows(from, to, hold ? 100 : 0);
    } };
  try {
    const router = new AssetDataRouter(provider, [], store.resources);
    sameRows(await read(router), rows(start, end));
    sameRows(await read(router, start, laterEnd), rows(start, laterEnd));
    now += 200; hold = true;
    sameRows(await read(router), rows(start, end));
    sameRows(await read(router), rows(start, end));
    sameRows(await read(router, start, laterEnd), rows(start, laterEnd));
    await Bun.sleep(0);
    expect(calls).toEqual([`${start.toISOString()}|${end.toISOString()}`, `${start.toISOString()}|${laterEnd.toISOString()}`,
      `${start.toISOString()}|${end.toISOString()}`, `${start.toISOString()}|${laterEnd.toISOString()}`]);
    release(); await Bun.sleep(0);
    sameRows(await read(router), rows(start, end, 100));
    sameRows(await read(router, start, laterEnd), rows(start, laterEnd, 100));
    expect(calls).toHaveLength(4);
  } finally { release(); await Bun.sleep(0); store.close(); clock.mockRestore(); }
});

test("exact history cache remains scoped to configured provider, exchange and bar", async () => {
  const store = new AppPersistence(createTempDbPath("exact-history-source"));
  const callsA: string[] = [], callsB: string[] = [];
  try {
    const a = new AssetDataRouter(source(callsA, "source-A"), [], store.resources);
    const b = new AssetDataRouter(source(callsB, "source-B", 100), [], store.resources);
    sameRows(await read(a), rows(start, end));
    sameRows(await read(b), rows(start, end, 100));
    sameRows(await read(a), rows(start, end));
    sameRows(await read(a, start, end, "1h"), rows(start, end));
    sameRows(await a.getDetailedPriceHistory("BTC-USD", "NASDAQ", start, end, "15m"), rows(start, end));
    expect(callsA).toHaveLength(3);
    expect(callsB).toHaveLength(1);
  } finally { store.close(); }
});

test("broker instance and contract identities stay separate while their intraday endpoints change", async () => {
  const store = new AppPersistence(createTempDbPath("exact-history-broker"));
  const calls: string[] = [];
  try {
    const router = new AssetDataRouter(null, [], store.resources);
    attachTestRegistry(router, { brokers: [["ibkr", { id: "ibkr", name: "Controlled broker", configSchema: [], validate: async () => true, importPositions: async () => [],
      async getDetailedPriceHistory(_ticker, instance, _exchange, from, to, _bar, instrument) {
        calls.push(`${instance.id}|${instrument?.conId}`);
        return rows(from, to, instance.id === "ibkr-A" ? 100 : 200);
      } }]] });
    setBrokerInstances(router, [brokerInstance({ id: "ibkr-A" }), brokerInstance({ id: "ibkr-B" })]);
    const context = (instance: string, conId: number): MarketDataRequestContext => ({ brokerId: "ibkr", brokerInstanceId: instance,
      instrument: { brokerId: "ibkr", brokerInstanceId: instance, symbol: "BTC", conId } });
    sameRows(await read(router, start, end, "15m", context("ibkr-A", 11)), rows(start, end, 100));
    sameRows(await read(router, laterStart, end, "15m", context("ibkr-A", 11)), rows(laterStart, end, 100));
    sameRows(await read(router, start, end, "15m", context("ibkr-B", 11)), rows(start, end, 200));
    sameRows(await read(router, start, end, "15m", context("ibkr-A", 12)), rows(start, end, 100));
    sameRows(await read(router, start, end, "15m", context("ibkr-A", 11)), rows(start, end, 100));
    expect(calls).toEqual(["ibkr-A|11", "ibkr-A|11", "ibkr-B|11", "ibkr-A|12"]);
  } finally { store.close(); }
});
