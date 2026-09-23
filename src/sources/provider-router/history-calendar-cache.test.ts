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

const upTo = (last: string, volume = 50_000_000): PricePoint[] => ["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"]
  .filter((date) => date <= last)
  .map((date) => ({ date: new Date(`${date}T00:00:00Z`), close: 200, volume: date === last ? volume : 50_000_000 }));

test("daily history missing a settled session is re-checked on a receding schedule shared by every process", async () => {
  const calls: string[] = [];
  let load = () => upTo("2026-09-21");
  const store = new AppPersistence(createTempDbPath("calendar-behind"));
  const provider = source(() => load(), calls);
  let router = new AssetDataRouter(provider, [], store.resources);
  const at = async (iso: string, range: "1M" | "1Y" = "1Y") => {
    setSystemTime(new Date(iso));
    return new Date((await router.getPriceHistory("NVDA", "NASDAQ", range)).at(-1)!.date).toISOString().slice(0, 10);
  };
  try {
    // Fetched after the 09-22 close settled, still without that session (a
    // halt, a late source): re-checked an hour later at the earliest.
    expect(await at("2026-09-22T20:31:00Z")).toBe("2026-09-21");
    await at("2026-09-22T21:20:00Z");
    expect(calls).toHaveLength(1);
    load = () => { throw new Error("offline"); };
    expect(await at("2026-09-22T21:35:00Z")).toBe("2026-09-21");
    expect(calls).toHaveLength(2);
    // A failed re-check binds a new process too.
    router = new AssetDataRouter(provider, [], store.resources);
    await at("2026-09-22T22:00:00Z");
    expect(calls).toHaveLength(2);
    // So does one that answers nothing usable: the 1M key is asked once and
    // the broader copy keeps answering.
    load = () => [];
    expect(await at("2026-09-22T22:40:00Z", "1M")).toBe("2026-09-21");
    expect(calls).toHaveLength(3);
    router = new AssetDataRouter(provider, [], store.resources);
    expect(await at("2026-09-22T23:10:00Z", "1M")).toBe("2026-09-21");
    expect(calls).toHaveLength(3);
    // Re-checks spread out as the close recedes: a quarter of its age apart.
    load = () => upTo("2026-09-21");
    await at("2026-09-23T06:00:00Z");
    await at("2026-09-23T07:00:00Z");
    expect(calls).toHaveLength(4);
    load = () => upTo("2026-09-22");
    expect(await at("2026-09-23T09:00:00Z")).toBe("2026-09-21");
    expect(await at("2026-09-23T09:30:00Z")).toBe("2026-09-22");
    await at("2026-09-23T19:00:00Z");
    expect(calls).toHaveLength(5);
  } finally { store.close(); }
});

test("a narrower range is not answered from a broader copy that is behind or in progress", async () => {
  const calls: string[] = [];
  let load = () => upTo("2026-09-21", 40_000_000);
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
    // The 1M key has its own copy upstream, so it is asked once.
    setSystemTime(new Date("2026-09-23T11:41:00Z"));
    await last("5Y");
    load = () => upTo("2026-09-22", 45_000_000);
    setSystemTime(new Date("2026-09-23T13:00:00Z"));
    expect((await last("1M")).date).toBe("2026-09-22");
    setSystemTime(new Date("2026-09-23T13:03:00Z"));
    expect((await last("1M")).date).toBe("2026-09-22");
    expect(calls).toEqual(["5Y", "1M"]);
    // Once the 1M copy is past its short TTL it still outranks the fresher
    // broader copy that is behind, even while its revalidation fails.
    load = () => { throw new Error("offline"); };
    setSystemTime(new Date("2026-09-23T13:10:00Z"));
    expect((await last("1M")).date).toBe("2026-09-22");
    await Bun.sleep(10);
    expect(calls).toEqual(["5Y", "1M", "1M"]);

    // A 5Y copy with today's in-progress bar is replaced after the close.
    // Its paced re-check lands during the session.
    load = () => upTo("2026-09-23", 1_236_003);
    setSystemTime(new Date("2026-09-23T17:00:00Z"));
    expect(await last("5Y")).toEqual({ date: "2026-09-23", volume: 1_236_003 });
    load = () => upTo("2026-09-23", 88_000_000);
    setSystemTime(new Date("2026-09-23T20:40:00Z"));
    expect((await last("1M")).volume).toBe(88_000_000);
    setSystemTime(new Date("2026-09-23T20:43:00Z"));
    expect((await last("1M")).volume).toBe(88_000_000);
    expect(calls).toEqual(["5Y", "1M", "1M", "5Y", "1M"]);
  } finally { store.close(); }
});

test("a narrow range of a listing that stays behind is not revalidated on its short TTL", async () => {
  const calls: string[] = [];
  const provider: DataProvider = { ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistory(_symbol, _exchange, range) {
    calls.push(range);
    return upTo("2026-09-21");
  } };
  const store = new AppPersistence(createTempDbPath("calendar-halted"));
  const router = new AssetDataRouter(provider, [], store.resources);
  try {
    setSystemTime(new Date("2026-09-23T10:00:00Z"));
    await router.getPriceHistory("HALT", "NASDAQ", "5Y");
    for (let time = Date.parse("2026-09-23T10:01:00Z"); time <= Date.parse("2026-09-23T20:00:00Z"); time += 60_000) {
      setSystemTime(new Date(time));
      await router.getPriceHistory("HALT", "NASDAQ", "1M");
      await Bun.sleep(0);
    }
    // One ask of the 1M key, then one paced re-check before the next close.
    expect(calls).toEqual(["5Y", "1M", "1M"]);
    // Without a broader copy, the 1M copy's own short TTL does not drive it either.
    calls.length = 0;
    for (let time = Date.parse("2026-09-23T10:01:00Z"); time <= Date.parse("2026-09-23T20:00:00Z"); time += 60_000) {
      setSystemTime(new Date(time));
      await router.getPriceHistory("STILL", "NASDAQ", "1M");
      await Bun.sleep(0);
    }
    expect(calls).toEqual(["1M", "1M"]);
  } finally { store.close(); }
}, 30_000);

test("a listing on a venue without published closures is not re-checked through its holidays", async () => {
  const calls: string[] = [];
  const provider: DataProvider = { ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistory(_symbol, _exchange, range) {
    calls.push(`${range} ${new Date().toISOString()}`);
    return upTo("2026-09-23");
  } };
  const store = new AppPersistence(createTempDbPath("calendar-krx"));
  const router = new AssetDataRouter(provider, [], store.resources);
  try {
    // KRX is closed for Chuseok, Thursday 09-24 to Saturday 09-26.
    for (let time = Date.parse("2026-09-24T00:00:00Z"); time < Date.parse("2026-09-28T00:00:00Z"); time += 10 * 60_000) {
      setSystemTime(new Date(time));
      await router.getPriceHistory("005930", "KRX", "1M");
      await router.getPriceHistory("005930", "KRX", "1Y");
      await Bun.sleep(0);
    }
    // One fetch per key a day, as before: the holiday is not a missing session.
    expect(calls.map((call) => call.slice(3, 13))).toEqual(["2026-09-24", "2026-09-24", "2026-09-24", "2026-09-24",
      "2026-09-25", "2026-09-25", "2026-09-26", "2026-09-26", "2026-09-27", "2026-09-27"]);
  } finally { store.close(); }
}, 30_000);

test("a copy fetched after the close outranks a broader copy holding the session in progress", async () => {
  const calls: string[] = [];
  let load = () => upTo("2026-09-23", 1_236_003);
  const provider: DataProvider = { ...fallbackProvider, id: "gloomberb-cloud", async getPriceHistory(_symbol, _exchange, range) {
    calls.push(range);
    return load();
  } };
  const store = new AppPersistence(createTempDbPath("calendar-tiers"));
  const router = new AssetDataRouter(provider, [], store.resources);
  const last = async (range: "1M" | "5Y") => new Date((await router.getPriceHistory("TSLA", "NASDAQ", range)).at(-1)!.date)
    .toISOString().slice(0, 10);
  try {
    // A 5Y copy fetched in session carries today's in-progress bar.
    setSystemTime(new Date("2026-09-23T17:00:00Z"));
    expect(await last("5Y")).toBe("2026-09-23");
    // After the close settles, the source has not published today's bar yet.
    load = () => upTo("2026-09-22");
    setSystemTime(new Date("2026-09-23T20:40:00Z"));
    expect(await last("1M")).toBe("2026-09-22");
    // The 1M copy answers, past its short TTL too, rather than the 5Y copy
    // whose later bar is the unfinished session.
    for (const time of ["2026-09-23T20:43:00Z", "2026-09-23T20:50:00Z", "2026-09-23T21:20:00Z"]) {
      setSystemTime(new Date(time));
      expect(await last("1M")).toBe("2026-09-22");
      await Bun.sleep(0);
    }
    expect(calls).toEqual(["5Y", "1M"]);
  } finally { store.close(); }
});

test("a copy fetched before the close is re-asked at most every five minutes while the refetch fails", async () => {
  const calls: string[] = [];
  let load = () => upTo("2026-09-23", 1_236_003);
  const store = new AppPersistence(createTempDbPath("calendar-unsettled-retry"));
  const provider = source(() => load(), calls);
  let router = new AssetDataRouter(provider, [], store.resources);
  const volume = async (iso: string, range: "1M" | "1Y" = "1Y") => {
    setSystemTime(new Date(iso));
    const volume = (await router.getPriceHistory("NVDA", "NASDAQ", range)).at(-1)?.volume;
    await Bun.sleep(0);
    return volume;
  };
  try {
    expect(await volume("2026-09-23T17:00:00Z")).toBe(1_236_003);
    load = () => { throw new Error("offline"); };
    expect(await volume("2026-09-23T20:31:00Z")).toBe(1_236_003);
    expect(calls).toHaveLength(2);
    await volume("2026-09-23T20:32:00Z");
    await volume("2026-09-23T20:35:00Z");
    // The pause binds a new process too.
    router = new AssetDataRouter(provider, [], store.resources);
    await volume("2026-09-23T20:35:30Z");
    expect(calls).toHaveLength(2);
    // An empty answer defers the next ask the same way; the broader copy
    // keeps answering meanwhile.
    load = () => [];
    expect(await volume("2026-09-23T20:36:00Z", "1M")).toBe(1_236_003);
    expect(calls).toHaveLength(3);
    expect(await volume("2026-09-23T20:40:00Z", "1M")).toBe(1_236_003);
    expect(calls).toHaveLength(3);
    load = () => upTo("2026-09-23", 88_000_000);
    expect(await volume("2026-09-23T20:41:00Z")).toBe(88_000_000);
    expect(calls).toHaveLength(4);
  } finally { store.close(); }
});
