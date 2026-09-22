import { describe, expect, test } from "bun:test";
import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { ChartRequest } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain, PricePoint } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, valueOption } from "../options-calculator/model";
import { createSurfaceDependencies } from "../vol-surface/client";
import { createRealizedVolatilityDependencies, loadCurrentAtmIv, loadRealizedVolatilityHistory } from "./client";

const now = Date.UTC(2026, 8, 22, 14);
const points: PricePoint[] = [{ date: new Date(now - 86400000), close: 100 }, { date: new Date(now), close: 101 }];
function ready<T>(data: T): QueryEntry<T> {
  return { phase: "ready", data, lastGoodData: data, source: "test", fetchedAt: now - 1000,
    staleAt: now + 60000, error: null, attempts: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("daily realized-volatility history", () => {
  test("requests explicit daily 5Y warmup with scoped identity and retains cached partial data", async () => {
    const instrument = { symbol: "AAPL", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "account" };
    let seen: ChartRequest | undefined;
    let forced = false;
    const result = await loadRealizedVolatilityHistory({ instrument, forceRefresh: true }, {
      now: () => now, loadChart: async (request, options) => {
        seen = request; forced = !!options?.forceRefresh;
        return { ...ready(points), data: null, phase: "error", error: { reasonCode: "UPSTREAM_ERROR", message: "refresh offline" } };
      },
    });
    expect(seen).toEqual({ instrument, bufferRange: "5Y", granularity: "resolution", resolution: "1d" });
    expect(forced).toBe(true);
    expect(result.history).toEqual(points);
    expect(result.source).toBe("test");
    expect(result.stale).toBe(true);
    expect(result.error).toBe("refresh offline");
    expect(result.fetchedAt).toBe(now - 1000);
  });

  test("daily headless adapter uses coordinator refresh/cache context and preserves the full buffer", async () => {
    const requests: unknown[][] = [];
    const provider = { id: "test", getPriceHistoryForResolution: async (...args: unknown[]) => { requests.push(args); return points; },
      getPriceHistory: async () => { throw new Error("range fallback must not replace daily history"); },
    } as unknown as DataProvider;
    const dependencies = createRealizedVolatilityDependencies(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "account" };
    await loadRealizedVolatilityHistory({ instrument, forceRefresh: true }, dependencies);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.slice(0, 4)).toEqual(["AAPL", "NASDAQ", "5Y", "1d"]);
    expect(requests[0]![4]).toMatchObject({ brokerId: "ibkr", brokerInstanceId: "account", cacheMode: "refresh" });
    const cached = await loadRealizedVolatilityHistory({ instrument }, dependencies);
    expect(cached.history).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  test("distinguishes hard failure, empty success and expired cached data", async () => {
    const request = { instrument: { symbol: "AAPL" } };
    const failed = await loadRealizedVolatilityHistory(request, { loadChart: async () => { throw new Error("history offline"); } });
    expect(failed.error).toBe("history offline");
    expect(failed.history).toHaveLength(0);
    const empty = await loadRealizedVolatilityHistory(request, { loadChart: async () => ready([]) });
    expect(empty.error).toBeTruthy();
    expect(empty.history).toHaveLength(0);
    const stale = await loadRealizedVolatilityHistory(request, { now: () => now,
      loadChart: async () => ({ ...ready(points), staleAt: now - 1 }) });
    expect(stale.stale).toBe(true);
    expect(stale.history).toEqual(points);
  });

  test("consumer cancellation rejects promptly without poisoning a shared daily request", async () => {
    const gate = deferred<PricePoint[]>();
    let calls = 0;
    const provider = { id: "test", getPriceHistoryForResolution: async () => { calls += 1; return gate.promise; } } as unknown as DataProvider;
    const coordinator = new MarketDataCoordinator(provider);
    const dependencies = { loadChart: coordinator.loadChart.bind(coordinator) };
    const controller = new AbortController();
    const cancelled = loadRealizedVolatilityHistory({ instrument: { symbol: "AAPL" }, signal: controller.signal }, dependencies);
    const retained = loadRealizedVolatilityHistory({ instrument: { symbol: "AAPL" } }, dependencies);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve(points);
    expect((await retained).history).toHaveLength(2);
    expect(calls).toBe(1);
    await expect(loadRealizedVolatilityHistory({ instrument: { symbol: "AAPL" }, signal: controller.signal }, dependencies))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
});

describe("independent current-IV loading", () => {
  test("loads shared surface quotes and recomputes ATM IV while retaining the actual source date", async () => {
    const expiration = now / 1000 + 31 * 86400;
    const daysToExpiry = daysToExpiryFrom(expiration, now);
    const contract = (strike: number, side: "call" | "put") => {
      const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: 100, strike,
        daysToExpiry, rate: 0.04, dividendYield: 0.01, volatility: 0.3 }).price;
      return { contractSymbol: `${side}-${strike}`, strike, expiration, currency: "USD", bid: price * 0.99,
        ask: price * 1.01, lastPrice: price, openInterest: 100, volume: 1, lastTradeDate: now / 1000,
        impliedVolatility: 0.5, change: 0, percentChange: 0, inTheMoney: false };
    };
    const strikes = [80, 90, 95, 100, 105, 110, 120];
    const chain: OptionsChain = { underlyingSymbol: "AAPL", expirationDates: [expiration],
      calls: strikes.map((strike) => contract(strike, "call")), puts: strikes.map((strike) => contract(strike, "put")),
      asOf: "2026-09-22T13:45:00Z", providerId: "test" };
    const provider = { id: "test", getOptionsChain: async () => chain } as unknown as DataProvider;
    const dependencies = createSurfaceDependencies(provider, { getCloudYieldCurve: async () => [
      { maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" },
    ] });
    const result = await loadCurrentAtmIv({ instrument: { symbol: "AAPL" }, spot: 100,
      spotAsOf: "2026-09-22T13:59:00Z" }, { ...dependencies, now: () => now });
    expect(result.reference!.value).toBeCloseTo(0.3, 4);
    expect(result.reference!.daysToExpiry).toBeCloseTo(daysToExpiry, 12);
    expect(result.reference!.expiration).toBe(expiration);
    expect(result.reference!.date.toISOString()).toBe("2026-09-22T13:45:00.000Z");
    expect(result.reference!.ivSource).toBe("recomputed");
    expect(result.error).toBeNull();
  });

  test("option failures and missing spot leave daily history independently available", async () => {
    const request = { instrument: { symbol: "AAPL" } };
    let calls = 0;
    const dependencies = { now: () => now, loadYieldCurve: async () => [],
      loadOptions: async () => { calls += 1; throw new Error("options unavailable"); } };
    const [history, options] = await Promise.all([
      loadRealizedVolatilityHistory(request, { loadChart: async () => ready(points) }),
      loadCurrentAtmIv({ ...request, spot: 100 }, dependencies),
    ]);
    expect(history.history).toHaveLength(2);
    expect(history.error).toBeNull();
    expect(options.reference).toBeNull();
    expect(options.error).toContain("options unavailable");
    const missingSpot = await loadCurrentAtmIv({ ...request, spot: NaN }, dependencies);
    expect(missingSpot.reference).toBeNull();
    expect(calls).toBe(1);
  });

  test("surface cancellation remains cancellation rather than a missing-IV result", async () => {
    const gate = deferred<QueryEntry<OptionsChain>>();
    const controller = new AbortController();
    const loading = loadCurrentAtmIv({ instrument: { symbol: "AAPL" }, spot: 100, signal: controller.signal }, {
      loadYieldCurve: async () => [], loadOptions: async () => gate.promise,
    });
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve(ready({ underlyingSymbol: "AAPL", expirationDates: [], calls: [], puts: [] }));
  });
});
