import { describe, expect, test } from "bun:test";
import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionsChain } from "../../../types/financials";
import { createSurfaceDependencies, loadVolatilitySurface, selectSurfaceExpiries, type SurfaceLoaderDependencies } from "./client";
import type { SurfaceSnapshot } from "./model";

const now = Date.UTC(2026, 8, 22, 14);
const expirations = Array.from({ length: 22 }, (_, index) => Date.UTC(2026, 9, index + 1) / 1000);
const curve = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" }];
const emptyChain = (dates = expirations): OptionsChain => ({ underlyingSymbol: "AAPL", expirationDates: dates, calls: [], puts: [] });
const ready = (data: OptionsChain): QueryEntry<OptionsChain> => ({ phase: "ready", data, lastGoodData: data,
  source: "test", fetchedAt: now, staleAt: now + 60_000, error: null, attempts: [] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("surface expiry selection", () => {
  const daily = Array.from({ length: 40 }, (_, index) => Date.UTC(2026, 8, 23 + index) / 1000);
  const days = (expiration: number) => (expiration * 1000 - now) / 86_400_000;

  test("thins daily listings geometrically before filling from the longest skipped tenor", () => {
    const selected = selectSurfaceExpiries(daily, 12, now);
    expect(selected).toHaveLength(12);
    expect(selected).toEqual([...selected].sort((a, b) => a - b));
    // Nearest-first would stop inside two weeks; thinning reaches the end of the listing.
    expect(days(selected.at(-1)!)).toBeGreaterThan(38);
    expect(selected.slice(0, 4).map(days).every((value, index, all) => index === 0 || value >= all[index - 1]! * 1.35)).toBe(true);
  });

  test("a short catalogue is requested completely and a larger limit is a superset", () => {
    const monthly = Array.from({ length: 10 }, (_, index) => Date.UTC(2026, 9 + index, 15) / 1000);
    expect(selectSurfaceExpiries(monthly, 18, now)).toEqual(monthly);
    const narrow = selectSurfaceExpiries(daily, 12, now), wide = selectSurfaceExpiries(daily, 24, now);
    expect(narrow.every((expiration) => wide.includes(expiration))).toBe(true);
    expect(wide).toHaveLength(24);
  });
});

describe("surface loader", () => {
  test("caps default catalogue, publishes partial failures and bounds concurrency at four", async () => {
    const outstanding = new Map<number, ReturnType<typeof deferred<QueryEntry<OptionsChain>>>>();
    let active = 0, maximum = 0;
    const snapshots: SurfaceSnapshot[] = [];
    const deps: SurfaceLoaderDependencies = { now: () => now, loadYieldCurve: async () => curve,
      loadOptions: async (request) => {
        if (request.expirationDate == null) return ready(emptyChain());
        active += 1; maximum = Math.max(maximum, active);
        const gate = deferred<QueryEntry<OptionsChain>>();
        outstanding.set(request.expirationDate, gate);
        try { return await gate.promise; } finally { active -= 1; }
      } };
    const loading = loadVolatilitySurface({ instrument: { symbol: "AAPL" }, spot: 100, onSnapshot: (value) => snapshots.push(value) }, deps);
    await settle();
    expect(outstanding.size).toBe(4);
    const [first, second] = [...outstanding.keys()].sort((a, b) => a - b) as [number, number];
    outstanding.get(first)!.resolve(ready(emptyChain()));
    outstanding.get(second)!.reject(new Error("one expiry failed"));
    await settle();
    expect(snapshots.some((snapshot) => snapshot.loaded === 1 && snapshot.phase === "partial")).toBe(true);
    expect(snapshots.at(-1)!.failures[0]!.expiration).toBe(second);
    const completed = new Set([first, second]);
    while (completed.size < 18) {
      for (const [expiry, gate] of outstanding) {
        if (completed.has(expiry)) continue;
        completed.add(expiry); gate.resolve(ready(emptyChain()));
      }
      await settle();
    }
    const result = await loading;
    expect(maximum).toBe(4);
    expect(result.catalogue).toHaveLength(22);
    expect(result.requested).toBe(18);
    expect(result.loaded).toBe(18);
    expect(result.failed).toBe(1);
    expect(result.expiries[1]!.state).toBe("error");
    expect(result.expiries[0]!.state).toBe("empty");
    expect(snapshots[0]!.loaded).toBe(0);
  });

  test("abort promptly rejects without scheduling or emitting superseded results", async () => {
    const gate = deferred<QueryEntry<OptionsChain>>();
    let calls = 0;
    const snapshots: SurfaceSnapshot[] = [];
    const controller = new AbortController();
    const loading = loadVolatilitySurface({ instrument: { symbol: "AAPL" }, spot: 100,
      signal: controller.signal, onSnapshot: (value) => snapshots.push(value) }, {
      now: () => now, loadYieldCurve: async () => curve,
      loadOptions: async (request) => { if (!request.expirationDate) return ready(emptyChain()); calls += 1; return gate.promise; },
    });
    await settle();
    expect(calls).toBe(4);
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    const count = snapshots.length;
    gate.resolve(ready(emptyChain()));
    await settle();
    expect(snapshots).toHaveLength(count);
    expect(calls).toBe(4);
  });

  test("rate failure preserves loaded slices and source failures instead of substituting a rate", async () => {
    const result = await loadVolatilitySurface({ instrument: { symbol: "AAPL" }, spot: 100, spotAsOf: "2026-09-22T13:59:00Z" }, {
      now: () => now, loadYieldCurve: async () => { throw new Error("Treasury offline"); },
      loadOptions: async () => ready(emptyChain(expirations.slice(0, 2))),
    });
    expect(result.loaded).toBe(2);
    expect(result.expiries.every((expiry) => expiry.rate === null)).toBe(true);
    expect(result.failures).toContainEqual({ expiration: null, message: "Treasury: Treasury offline" });
    expect(result.spotAsOf).toBe("2026-09-22T13:59:00Z");
  });

  test("incremental loads share exact coordinator keys with an options monitor", async () => {
    const fetched: (number | undefined)[] = [];
    const provider = { id: "test", getOptionsChain: async (_symbol: string, _exchange: string, expiry?: number) => {
      fetched.push(expiry); return emptyChain();
    } } as unknown as ConstructorParameters<typeof MarketDataCoordinator>[0];
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };
    const deps = { now: () => now, loadYieldCurve: async () => curve,
      loadOptions: coordinator.loadOptions.bind(coordinator) };
    await coordinator.loadOptions({ instrument, expirationDate: expirations[0] });
    await loadVolatilitySurface({ instrument, spot: 100 }, deps);
    await loadVolatilitySurface({ instrument, spot: 100, limit: 22 }, deps);
    expect(fetched).toHaveLength(23);
    expect(fetched.filter((expiry) => expiry === expirations[0])).toHaveLength(1);
    expect(new Set(fetched).size).toBe(23);
  });

  test("headless dependencies use the same coordinator loader and expose missing catalogue", async () => {
    const marketData = { id: "headless", getOptionsChain: async () => { throw new Error("chain offline"); } } as unknown as ConstructorParameters<typeof MarketDataCoordinator>[0];
    const deps = createSurfaceDependencies(marketData, { getCloudYieldCurve: async () => curve });
    const result = await loadVolatilitySurface({ instrument: { symbol: "AAPL" }, spot: 100 }, { ...deps, now: () => now });
    expect(result.phase).toBe("error");
    expect(result.failures[0]!.message).toBe("chain offline");
    expect(result.requested).toBe(0);
  });

  test("a forced surface refresh reuses the catalogue's proven first slice", async () => {
    const calls: (number | undefined)[] = [];
    const provider = { id: "test", getOptionsChain: async (_symbol: string, _exchange: string, expiry?: number) => {
      calls.push(expiry);
      return { ...emptyChain(expirations.slice(0, 2)), calls: [{ expiration: expiry ?? expirations[0], strike: 100, bid: 0, ask: 0 }] };
    } } as unknown as ConstructorParameters<typeof MarketDataCoordinator>[0];
    const coordinator = new MarketDataCoordinator(provider);
    await loadVolatilitySurface({ instrument: { symbol: "AAPL" }, spot: 100, forceRefresh: true }, {
      now: () => now, loadYieldCurve: async () => curve, loadOptions: coordinator.loadOptions.bind(coordinator),
    });
    expect(calls).toEqual([undefined, expirations[1]]);
  });
});
