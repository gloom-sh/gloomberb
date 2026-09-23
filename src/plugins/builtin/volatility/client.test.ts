import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetFredSeriesPersistence, type FredSeriesData } from "../../../data/fred-series";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import type { ChartRequest } from "../../../market-data/request-types";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { createVolatilityDependencies, getCachedVolatilityData, loadVolatilityData, volatilityHistoryRequest,
  type VolatilityLoaderDependencies, type VolatilityLoadResult } from "./client";

const now = Date.UTC(2026, 8, 22, 14);
const points: PricePoint[] = [{ date: new Date("2026-09-18"), close: 20 }, { date: new Date("2026-09-21"), close: 22 }];
function ready(data = points): QueryEntry<PricePoint[]> {
  return { phase: "ready", data, lastGoodData: data, source: "test-router", fetchedAt: now - 1000,
    staleAt: now + 60000, error: null, attempts: [] };
}
function fred(id: string): FredSeriesData {
  return { observations: [{ date: "2026-09-18", value: id === "VIXCLS" ? 20 : 24 }], info: {
    id, title: id, units: "Index", frequency: "Daily, Close", seasonalAdjustment: "Not Seasonally Adjusted",
    source: "FRED", notes: "", observationEnd: "2026-09-17",
  } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise<void>((done) => setTimeout(done, 0));
beforeEach(resetFredSeriesPersistence);
afterEach(() => { resetFredSeriesPersistence(); setSharedMarketDataCoordinator(null); });

describe("volatility source loader", () => {
  test("limits all source work to four jobs while publishing independent immutable partial results", async () => {
    let active = 0, peak = 0;
    const pending: Array<() => void> = [];
    const snapshots: VolatilityLoadResult[] = [];
    const seen: ChartRequest[] = [];
    const fredRequests: unknown[][] = [];
    const delayed = <T,>(value: T) => {
      const gate = deferred<T>();
      active += 1; peak = Math.max(peak, active);
      pending.push(() => { active -= 1; gate.resolve(value); });
      return gate.promise;
    };
    const loading = loadVolatilityData(true, { now: () => now,
      loadChart: (request, options) => { seen.push(request); expect(options?.forceRefresh).toBe(true); return delayed(ready()); },
      loadFred: (id, options) => { fredRequests.push([id, options]); return delayed(fred(id)); },
    }, { onSnapshot: (snapshot) => snapshots.push(snapshot) });
    await settle();
    expect(active).toBe(4);
    expect(snapshots[0]?.phase).toBe("loading");
    // The core VIX history can become usable before either FRED call returns.
    pending.splice(1, 1)[0]!();
    await settle();
    expect(snapshots[1]?.data.board.find((row) => row.id === "vix")?.value).toBe(22);
    expect(snapshots[1]?.loaded).toBe(1);
    expect(snapshots[1]?.phase).toBe("partial");
    expect(snapshots[0]?.data.board.every((row) => row.value == null)).toBe(true);
    while (pending.length) { pending.splice(0).forEach((resolve) => resolve()); await settle(); }
    const result = await loading;
    expect(peak).toBe(4);
    expect(result.loaded).toBe(24);
    expect(snapshots.at(-1)?.loaded).toBe(24);
    expect(seen).toHaveLength(22);
    expect(seen.every((request) => request.instrument.exchange === "" && request.bufferRange === "1Y"
      && request.granularity === "resolution" && request.resolution === "1d")).toBe(true);
    expect(fredRequests).toEqual([["VIXCLS", { limit: 400, sortOrder: "desc" }], ["VXVCLS", { limit: 400, sortOrder: "desc" }]]);
    expect(result.data.curve.date).toBe("2026-09-21");
    expect(result.data.fred.termDate).toBe("2026-09-18");
  });

  test("retains last-good daily data on failure while empty success clears a prior source", async () => {
    const cache = (request: ChartRequest) => ["^VIX", "^VIX3M", "^VVIX"].includes(request.instrument.symbol) ? ready() : createIdleEntry<PricePoint[]>();
    const result = await loadVolatilityData(true, { now: () => now, getChartEntry: cache,
      loadChart: async (request) => {
        if (request.instrument.symbol === "^VIX") throw new Error("refresh offline");
        if (request.instrument.symbol === "^VIX3M") return { ...ready(), phase: "error", data: null,
          error: { reasonCode: "UPSTREAM_ERROR", message: "router failed" } };
        return ready([]);
      }, loadFred: async () => { throw new Error("FRED unavailable"); },
    });
    expect(result.phase).toBe("partial");
    expect(result.stale).toBe(true);
    expect(result.data.board.find((row) => row.id === "vix")).toMatchObject({ value: 22, date: "2026-09-21", source: "test-router", stale: true, error: "refresh offline" });
    expect(result.data.board.find((row) => row.id === "vix3m")).toMatchObject({ value: 22, stale: true, error: "router failed" });
    expect(result.data.board.find((row) => row.id === "vvix")).toMatchObject({ value: null, date: null, stale: false });
    expect(result.data.curve.ratio).toBe(1);
    expect(result.data.curve.warnings.join(" ")).toContain("stale cached history");
  });

  test("reuses coordinator and FRED caches and forwards explicit refresh only when requested", async () => {
    const calls: unknown[][] = [];
    let fredCalls = 0;
    const provider = { id: "test", getPriceHistoryForResolution: async (...args: unknown[]) => { calls.push(args); return points; },
      getPriceHistory: async () => { throw new Error("range fallback must not replace daily history"); },
    } as unknown as DataProvider;
    const coordinator = new MarketDataCoordinator(provider);
    setSharedMarketDataCoordinator(coordinator);
    const dependencies = createVolatilityDependencies(undefined, { getCloudFredSeries: async (id) => { fredCalls += 1; return fred(id); } });
    await coordinator.loadChart(volatilityHistoryRequest("^VIX"));
    const cached = getCachedVolatilityData(dependencies);
    expect(cached?.data.board.find((row) => row.id === "vix")?.value).toBe(22);
    await loadVolatilityData(false, dependencies);
    await loadVolatilityData(false, dependencies);
    expect(calls).toHaveLength(22);
    expect(fredCalls).toBe(2);
    await loadVolatilityData(true, dependencies);
    expect(calls).toHaveLength(44);
    expect(fredCalls).toBe(4);
    expect(calls[0]?.slice(0, 4)).toEqual(["^VIX", "", "1Y", "1d"]);
    expect(calls[22]?.[4]).toMatchObject({ cacheMode: "refresh" });
  });

  test("failed empty sources do not mark fresh displayed observations stale", async () => {
    for (const retainOldData of [false, true]) {
      const result = await loadVolatilityData(true, { now: () => now,
        loadChart: async (request) => request.instrument.symbol === "^VIX" ? ready() : {
          ...createIdleEntry<PricePoint[]>(), phase: "error",
          lastGoodData: retainOldData && request.instrument.symbol === "^RVX" ? points : null,
          staleAt: now - 1, error: { reasonCode: "NO_DATA", message: "Daily history unavailable" },
        },
        loadFred: async () => ({ observations: [], info: null, stale: true }),
      });
      expect(result.phase).toBe("partial");
      expect(result.stale).toBe(retainOldData);
      expect(result.data.board.find((row) => row.id === "vix")).toMatchObject({ value: 22, stale: false });
      expect(result.data.board.find((row) => row.id === "rvx")).toMatchObject({ value: retainOldData ? 22 : null, stale: retainOldData });
      expect(result.data.fred.metrics.every((metric) => !metric.stale)).toBe(true);
    }
  });

  test("invalid FRED identities cannot replace the dated cache and stale refresh remains usable", async () => {
    let wrong = false;
    const dependencies: VolatilityLoaderDependencies = { now: () => now, loadChart: async () => ready([]),
      loadFred: async (id) => wrong ? fred("OTHER") : fred(id) };
    await loadVolatilityData(false, dependencies);
    wrong = true;
    const result = await loadVolatilityData(true, dependencies);
    expect(result.data.curve).toMatchObject({ source: "fred", date: "2026-09-18", ratio: 1.2 });
    expect(result.data.fred.metrics.every((metric) => metric.stale)).toBe(true);
    expect(result.data.fred.metrics[0]).toMatchObject({ date: "2026-09-18", observationEnd: "2026-09-17", value: 20 });
    expect(result.errors.join(" ")).toContain("Unexpected FRED series identity or units");
    const cached = getCachedVolatilityData(dependencies);
    expect(cached?.data.fred.metrics[0]?.title).toBe("VIXCLS");
  });

  test("implied correlation rows use one CBOE history request, not the index route", async () => {
    let correlationCalls = 0;
    const charts: string[] = [];
    // The board's 1Y percentile needs 200 closes spanning 300 days.
    const dates = Array.from({ length: 360 }, (_, index) => new Date(Date.UTC(2025, 8, 25) + index * 86_400_000).toISOString().slice(0, 10));
    const result = await loadVolatilityData(false, {
      loadChart: async (request) => { charts.push(request.instrument.symbol); throw new Error("no index route"); },
      loadFred: async () => { throw new Error("cloud offline"); },
      loadImpliedCorrelation: async () => {
        correlationCalls += 1;
        return [{ id: "COR1M", source: "cboe", observations: dates.map((date, index) => ({ date, value: 10 + (index % 20) })) },
          { id: "COR3M", source: "cboe", observations: [] }];
      },
      now: () => now,
    });
    expect(correlationCalls).toBe(1);
    expect(charts).not.toContain("^COR1M");
    const cor1m = result.data.board.find((row) => row.id === "cor1m")!;
    expect(cor1m).toMatchObject({ value: 10 + (359 % 20), source: "cboe", date: dates.at(-1) });
    expect(cor1m.percentile1y).not.toBeNull();
    expect(result.data.board.find((row) => row.id === "cor3m")).toMatchObject({ value: null, error: "COR3M history unavailable" });
  });

  test("returns an explicit no-data envelope after independent source failures", async () => {
    const result = await loadVolatilityData(false, { loadChart: async () => { throw new Error("history offline"); },
      loadFred: async () => { throw new Error("cloud offline"); } });
    expect(result).toMatchObject({ phase: "error", loaded: 24, total: 24, stale: false });
    expect(result.errors).toHaveLength(24);
    expect(result.data.board.every((row) => row.value == null)).toBe(true);
    expect(result.data.curve.date).toBeNull();
  });

  test("cancellation suppresses late publications and queued jobs without cancelling shared work", async () => {
    const gate = deferred<void>();
    let calls = 0;
    const snapshots: VolatilityLoadResult[] = [];
    const controller = new AbortController();
    const dependencies: VolatilityLoaderDependencies = {
      loadChart: async () => { calls += 1; await gate.promise; return ready(); },
      loadFred: async (id) => { calls += 1; await gate.promise; return fred(id); },
    };
    const loading = loadVolatilityData(false, dependencies, { signal: controller.signal, onSnapshot: (snapshot) => snapshots.push(snapshot) });
    await settle();
    expect(calls).toBe(4);
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await settle();
    expect(calls).toBe(4);
    expect(snapshots).toHaveLength(1);
    await expect(loadVolatilityData(false, dependencies, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(4);
    // Completed shared FRED requests remain cached for the next consumer.
    expect(getCachedVolatilityData(dependencies)?.data.fred.termDate).toBe("2026-09-18");
  });
});
