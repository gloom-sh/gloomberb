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
