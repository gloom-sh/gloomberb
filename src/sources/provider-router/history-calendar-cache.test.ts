import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import { AssetDataRouter } from "./index";
import { cleanupProviderRouterTestFiles, createTempDbPath, fallbackProvider } from "./test-support";

const daily = (last: string, close: number): PricePoint[] => ["2026-09-17", "2026-09-18", "2026-09-21", last]
  .map((date, index) => ({ date: new Date(`${date}T00:00:00Z`), close: index === 3 ? close : 200 + index }));

function source(load: () => PricePoint[], calls: string[]): DataProvider {
  return { ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistory() { calls.push(new Date().toISOString()); return load(); } };
}
afterEach(() => { setSystemTime(); cleanupProviderRouterTestFiles(); });

test("daily history fetched before a close is refetched, and kept when the refetch fails", async () => {
  const calls: string[] = [];
  let load = () => daily("2026-09-22", 219.65);
  const store = new AppPersistence(createTempDbPath("calendar-close"));
  const router = new AssetDataRouter(source(() => load(), calls), [], store.resources);
  const close = async (symbol = "NVDA", exchange = "NASDAQ") => (await router.getPriceHistory(symbol, exchange, "1Y")).at(-1)?.close;
  try {
    setSystemTime(new Date("2026-09-22T17:00:00Z"));
    expect(await close()).toBe(219.65);
    setSystemTime(new Date("2026-09-22T20:29:00Z"));
    expect(await close()).toBe(219.65);
    expect(calls).toHaveLength(1);
    // The session closed at 20:00 UTC; its bars settle 30 minutes later.
    load = () => daily("2026-09-22", 228.87);
    setSystemTime(new Date("2026-09-22T20:31:00Z"));
    expect(await close()).toBe(228.87);
    setSystemTime(new Date("2026-09-23T09:48:00Z"));
    expect(await close()).toBe(228.87);
    expect(calls).toHaveLength(2);
    load = () => { throw new Error("offline"); };
    setSystemTime(new Date("2026-09-23T20:31:00Z"));
    expect(await close()).toBe(228.87);
    expect(calls).toHaveLength(3);
    // A 24/7 series goes out of date within the hour.
    load = () => daily("2026-09-23", 85_000);
    expect(await close("BTC-USD", "CCC")).toBe(85_000);
    load = () => daily("2026-09-23", 86_000);
    setSystemTime(new Date("2026-09-23T21:20:00Z"));
    expect(await close("BTC-USD", "CCC")).toBe(85_000);
    setSystemTime(new Date("2026-09-23T21:32:00Z"));
    expect(await close("BTC-USD", "CCC")).toBe(86_000);
  } finally { store.close(); }
});

test("a weekly series ending in a trade-time row is refetched after the close", async () => {
  const calls: string[] = [];
  // Yahoo's weekly chart before the close: the week row stops at Monday and
  // the live observation trails it, so the points share no clock time.
  let load = (): PricePoint[] => [["2026-09-08T04:00:00Z", 230], ["2026-09-15T04:00:00Z", 236], ["2026-09-21T04:00:00Z", 227.38],
    ["2026-09-22T19:53:00Z", 228.1]].map(([date, close]) => ({ date: new Date(date as string), close: close as number }));
  const store = new AppPersistence(createTempDbPath("calendar-weekly"));
  const router = new AssetDataRouter(source(() => load(), calls), [], store.resources);
  try {
    setSystemTime(new Date("2026-09-22T19:55:00Z"));
    expect((await router.getPriceHistory("NVDA", "NASDAQ", "5Y")).at(-1)?.close).toBe(228.1);
    load = () => [{ date: new Date("2026-09-15T04:00:00Z"), close: 236 }, { date: new Date("2026-09-21T04:00:00Z"), close: 228.87 }];
    setSystemTime(new Date("2026-09-23T10:00:00Z"));
    expect((await router.getPriceHistory("NVDA", "NASDAQ", "5Y")).at(-1)?.close).toBe(228.87);
    expect(calls).toHaveLength(2);
  } finally { store.close(); }
});

test("daily history missing a settled session is re-checked at most hourly", async () => {
  const calls: string[] = [];
  let load = () => daily("2026-09-21", 210);
  const store = new AppPersistence(createTempDbPath("calendar-behind"));
  const router = new AssetDataRouter(source(() => load(), calls), [], store.resources);
  const last = async () => new Date((await router.getPriceHistory("NVDA", "NASDAQ", "1Y")).at(-1)!.date).toISOString().slice(0, 10);
  try {
    // Fetched after the 09-22 close, still without that session (a halt, a
    // late source, or a listing on another schedule).
    setSystemTime(new Date("2026-09-23T10:00:00Z"));
    expect(await last()).toBe("2026-09-21");
    setSystemTime(new Date("2026-09-23T10:50:00Z"));
    await last();
    expect(calls).toHaveLength(1);
    setSystemTime(new Date("2026-09-23T11:05:00Z"));
    await last();
    setSystemTime(new Date("2026-09-23T11:40:00Z"));
    await last();
    expect(calls).toHaveLength(2);
    // A failed re-check is bounded the same way.
    load = () => { throw new Error("offline"); };
    setSystemTime(new Date("2026-09-23T12:10:00Z"));
    expect(await last()).toBe("2026-09-21");
    setSystemTime(new Date("2026-09-23T12:40:00Z"));
    await last();
    expect(calls).toHaveLength(3);
    load = () => daily("2026-09-22", 219);
    setSystemTime(new Date("2026-09-23T13:15:00Z"));
    expect(await last()).toBe("2026-09-22");
    setSystemTime(new Date("2026-09-23T19:00:00Z"));
    await last();
    expect(calls).toHaveLength(4);
  } finally { store.close(); }
});

test("a narrower range is not answered from a broader copy that is behind or in progress", async () => {
  const calls: string[] = [];
  const bars = (last: string, volume: number): PricePoint[] => ["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"]
    .filter((date) => date <= last)
    .map((date) => ({ date: new Date(`${date}T00:00:00Z`), close: 200, volume: date === last ? volume : 50_000_000 }));
  let load = () => bars("2026-09-21", 40_000_000);
  const provider: DataProvider = { ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistory(_symbol, _exchange, range) {
    calls.push(range);
    return load();
  } };
  const store = new AppPersistence(createTempDbPath("calendar-broader"));
  const router = new AssetDataRouter(provider, [], store.resources);
  const last = async (range: "1M" | "5Y") => {
    const point = (await router.getPriceHistory("TSLA", "NASDAQ", range)).at(-1)!;
    return { date: new Date(point.date).toISOString().slice(0, 10), volume: point.volume };
  };
  try {
    // A 5Y copy fetched mid-morning after the backend dropped Monday's row.
    setSystemTime(new Date("2026-09-23T11:41:00Z"));
    await last("5Y");
    load = () => bars("2026-09-22", 45_000_000);
    setSystemTime(new Date("2026-09-23T13:00:00Z"));
    expect((await last("1M")).date).toBe("2026-09-22");
    // The fresh 1M copy now answers; the broader copy does not force refetches.
    setSystemTime(new Date("2026-09-23T13:03:00Z"));
    expect((await last("1M")).date).toBe("2026-09-22");
    expect(calls).toEqual(["5Y", "1M"]);
    // Once the 1M copy is past its short TTL, it still outranks the broader
    // copy that is behind, even while its revalidation fails.
    load = () => { throw new Error("offline"); };
    setSystemTime(new Date("2026-09-23T13:10:00Z"));
    expect((await last("1M")).date).toBe("2026-09-22");
    await Bun.sleep(10);
    expect(calls).toEqual(["5Y", "1M", "1M"]);

    // A 5Y copy with today's in-progress bar is replaced after the close.
    load = () => bars("2026-09-23", 1_236_003);
    setSystemTime(new Date("2026-09-23T15:00:00Z"));
    await last("5Y");
    load = () => bars("2026-09-23", 88_000_000);
    setSystemTime(new Date("2026-09-23T20:40:00Z"));
    expect((await last("1M")).volume).toBe(88_000_000);
    setSystemTime(new Date("2026-09-23T20:43:00Z"));
    expect((await last("1M")).volume).toBe(88_000_000);
    expect(calls).toEqual(["5Y", "1M", "1M", "5Y", "1M"]);
  } finally { store.close(); }
});
