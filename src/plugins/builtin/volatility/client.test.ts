import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetFredSeriesPersistence, type FredSeriesData } from "../../../sources/gloomberb-cloud/fred-series";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import type { ChartRequest } from "../../../market-data/request-types";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { collectSavedCopies, servedFromSavedCopy } from "../../../data/saved-copies";
import { ApiRequestError } from "../../../api-client/errors";
import { outage } from "../../../test-support/outage";
import { createVolatilityDependencies, getCachedVolatilityData, loadVolatilityData, loadVolatilityTermHistory, volatilityHistoryRequest,
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
const settle = () => new Promise<void>((done) => setTimeout(done, 0));
beforeEach(resetFredSeriesPersistence);
afterEach(() => { resetFredSeriesPersistence(); setSharedMarketDataCoordinator(null); });

describe("volatility source loader", () => {
  test("limits all source work to eight jobs while publishing independent immutable partial results", async () => {
    let active = 0, peak = 0;
    const pending: Array<() => void> = [];
    const snapshots: VolatilityLoadResult[] = [];
    const seen: ChartRequest[] = [];
    const fredRequests: unknown[][] = [];
    const delayed = <T,>(value: T) => {
      const gate = Promise.withResolvers<T>();
      active += 1; peak = Math.max(peak, active);
      pending.push(() => { active -= 1; gate.resolve(value); });
      return gate.promise;
    };
    const loading = loadVolatilityData(true, { now: () => now,
      loadChart: (request, options) => { seen.push(request); expect(options?.forceRefresh).toBe(true); return delayed(ready()); },
      loadFred: (id, options) => { fredRequests.push([id, options]); return delayed(fred(id)); },
    }, { onSnapshot: (snapshot) => snapshots.push(snapshot) });
    await settle();
    expect(active).toBe(8);
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
    expect(peak).toBe(8);
    expect(result.loaded).toBe(23);
    expect(snapshots.at(-1)?.loaded).toBe(23);
    expect(seen).toHaveLength(21);
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
    // Cache age alone does not mark the first paint stale; the load that follows decides.
    const seeded = getCachedVolatilityData({ now: () => now, getChartEntry: () => ({ ...ready(), staleAt: now - 1 }),
      loadChart: async () => ready(), loadFred: async (id) => fred(id) });
    expect(seeded?.stale).toBe(false);
    expect(seeded?.data.board.find((row) => row.id === "vix")?.stale).toBe(false);
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
    expect(calls).toHaveLength(21);
    expect(fredCalls).toBe(2);
    await loadVolatilityData(true, dependencies);
    expect(calls).toHaveLength(42);
    expect(fredCalls).toBe(4);
    expect(calls[0]?.slice(0, 4)).toEqual(["^VIX", "", "1Y", "1d"]);
    expect(calls[21]?.[4]).toMatchObject({ cacheMode: "refresh" });
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

  // A saved copy answered a refused session, a series no longer served and a reply for another series with
  // "saved copy from"; only a failure asking again may get past is answered by it.
  test("a refusal or an invalid FRED reply is the error over the closes kept; an outage is answered by the saved copy", async () => {
    let failure: (id: string) => Promise<FredSeriesData> = async (id) => fred(id);
    const dependencies: VolatilityLoaderDependencies = { now: () => now, loadChart: async () => ready([]), loadFred: (id) => failure(id) };
    await loadVolatilityData(false, dependencies);
    for (const [refusal, said] of [[async () => fred("OTHER"), "Unexpected FRED series identity or units"],
      [async () => { throw new ApiRequestError("Series not found", 404); }, "Series not found"],
      [async () => { throw new ApiRequestError("Sign in to continue", 401); }, "Sign in to continue"]] as const) {
      failure = refusal;
      const result = await loadVolatilityData(true, dependencies);
      expect(result.data.curve).toMatchObject({ source: "fred", date: "2026-09-18", ratio: 1.2 });
      expect(result.data.fred.metrics.every((metric) => metric.stale)).toBe(true);
      expect(result.data.fred.metrics[0]).toMatchObject({ date: "2026-09-18", observationEnd: "2026-09-17", value: 20 });
      expect(result.errors.join(" ")).toContain(said);
      expect(result.savedAt).toBeUndefined();
    }
    failure = async () => { throw outage(); };
    const offline = await loadVolatilityData(true, dependencies);
    expect(offline.savedAt).toBeNumber();
    expect(offline.errors.filter((error) => /^(VIXCLS|VXVCLS):/.test(error))).toEqual([]);
    expect(getCachedVolatilityData(dependencies)?.data.fred.metrics[0]?.title).toBe("VIXCLS");
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
    expect(result).toMatchObject({ phase: "error", loaded: 23, total: 23, stale: false });
    expect(result.errors).toHaveLength(23);
    expect(result.data.board.every((row) => row.value == null)).toBe(true);
    expect(result.data.curve.date).toBeNull();
  });

  test("cancellation suppresses late publications and queued jobs without cancelling shared work", async () => {
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const snapshots: VolatilityLoadResult[] = [];
    const controller = new AbortController();
    const dependencies: VolatilityLoaderDependencies = {
      loadChart: async () => { calls += 1; await gate.promise; return ready(); },
      loadFred: async (id) => { calls += 1; await gate.promise; return fred(id); },
    };
    const loading = loadVolatilityData(false, dependencies, { signal: controller.signal, onSnapshot: (snapshot) => snapshots.push(snapshot) });
    await settle();
    expect(calls).toBe(8);
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await settle();
    expect(calls).toBe(8);
    expect(snapshots).toHaveLength(1);
    await expect(loadVolatilityData(false, dependencies, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(8);
    // Completed shared FRED requests remain cached for the next consumer.
    expect(getCachedVolatilityData(dependencies)?.data.fred.termDate).toBe("2026-09-18");
  });

  test("the ratio history names FRED when it stands in for Cboe, dates the saved closes it reads, and fails with both reasons when neither has a pair", async () => {
    const cboe = (data: PricePoint[]) => ({ ...ready(data), source: "test" });
    const fredPoints = (stale = false, savedAt?: number) => async (id: string) => ({ stale, ...(savedAt ? { refreshError: "offline", savedAt } : {}),
      points: [{ date: "2026-09-17", value: id === "VIXCLS" ? 20 : 24 }, { date: "2026-09-18", value: id === "VIXCLS" ? 20 : 25 }] });
    const load = (dependencies: Partial<NonNullable<Parameters<typeof loadVolatilityTermHistory>[1]>>) => loadVolatilityTermHistory({}, {
      now: () => now, loadFred: async () => { throw new Error("unused"); }, loadChart: async () => cboe(points), loadFredPoints: fredPoints(), ...dependencies });
    // Both publishers: Cboe's closes end the history, with nothing to say.
    expect(await load({})).toMatchObject({ term: { termDate: "2026-09-21", publisher: "Cboe" } });
    expect((await load({})).warning).toBeUndefined();
    // Cboe down: FRED's closes end a day earlier, and the report says why.
    const fallback = await load({ loadChart: async () => { throw new Error("timeout"); } });
    expect(fallback.term).toMatchObject({ termDate: "2026-09-18", publisher: "FRED", ratio: 1.25 });
    expect(fallback.warning).toBe("Cboe closes unavailable (timeout); showing FRED's, through 2026-09-18.");
    // FRED down: Cboe's year alone, starting where it starts.
    expect((await load({ loadFredPoints: async () => { throw new Error("FRED offline"); } })).warning)
      .toBe("FRED closes unavailable (FRED offline); showing Cboe's from 2026-09-18.");
    // Closes the router answered from its saved copy say when it was saved, as every pane's saved copy does;
    // closes kept from an earlier answer, or a fresh answer with no data, say their error instead.
    const saved = await collectSavedCopies(() => load({ loadChart: async () => ({ ...cboe(points),
      history: servedFromSavedCopy({ sourceKey: "test" }, now - 1000) as NonNullable<QueryEntry<PricePoint[]>["history"]> }) }));
    expect(saved).toMatchObject({ savedAt: now - 1000 });
    expect(saved.warning).toBeUndefined();
    const kept = await load({ loadChart: async () => ({ ...cboe(points), error: { reasonCode: "NO_DATA", message: "no data" } }) });
    expect(kept.savedAt).toBeUndefined();
    expect(kept.warning).toBe("Refresh failed (no data); showing cached Cboe closes.");
    const savedFred = await load({ loadChart: async () => { throw new Error("timeout"); }, loadFredPoints: fredPoints(true, now - 5000) });
    expect(savedFred).toMatchObject({ savedAt: now - 5000, warning: "Cboe closes unavailable (timeout); showing FRED's, through 2026-09-18." });
    expect((await load({ loadChart: async () => cboe([]), loadFredPoints: fredPoints(true) })).warning)
      .toBe("Cboe closes unavailable (Daily index history unavailable); showing FRED's, through 2026-09-18. Showing cached FRED closes; the source has not updated since.");
    // Neither: an error, never an empty series.
    await expect(load({ loadChart: async () => { throw new Error("timeout"); }, loadFredPoints: async () => { throw new Error("FRED offline"); } }))
      .rejects.toThrow("VIX 3M / VIX history unavailable: Cboe closes (timeout); FRED closes (FRED offline)");
  });
});
