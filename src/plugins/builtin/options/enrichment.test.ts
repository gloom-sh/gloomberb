import { describe, expect, test } from "bun:test";
import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildOptionsKey } from "../../../market-data/selectors";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, valueOption } from "../options-calculator/model";
import { selectSurfaceExpiries } from "../vol-surface/client";
import { loadOptionsEnrichment } from "./enrichment-client";
import { optionsEnrichmentNeighbour, projectOptionsEnrichment, type OptionsEnrichmentSelection,
  type OptionsEnrichmentSnapshot } from "./enrichment-model";

const now = Date.UTC(2026, 8, 22, 14);
const expiry = (days: number) => (now + days * 86400000) / 1000;
const selected = expiry(60);
const next = expiry(90);
const curve = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" },
  { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-09-21" }];
const instrument = { symbol: "AAPL", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "account" };

function chain(expiration = selected, volatility: number | ((strike: number) => number) = 0.3): OptionsChain {
  const contract = (strike: number, side: "call" | "put") => {
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: 100, strike,
      daysToExpiry: daysToExpiryFrom(expiration, now), rate: 0.04, dividendYield: 0.01,
      volatility: typeof volatility === "number" ? volatility : volatility(strike) }).price;
    return { contractSymbol: `${side}-${strike}-${expiration}`, strike, expiration, currency: "USD",
      bid: price * 0.99, ask: price * 1.01, lastPrice: price * 2, openInterest: 100, volume: 1,
      impliedVolatility: 0.75, change: 0, percentChange: 0, lastTradeDate: now / 1000, inTheMoney: false };
  };
  const strikes = [60, 70, 80, 85, 90, 95, 100, 105, 110, 115, 120, 130, 140];
  return { underlyingSymbol: "AAPL", expirationDates: [selected, next],
    calls: strikes.map((strike) => contract(strike, "call")), puts: strikes.map((strike) => contract(strike, "put")),
    asOf: "2026-09-22T13:45:00Z", providerId: "test" };
}
function ready(data: OptionsChain): QueryEntry<OptionsChain> {
  return { phase: "ready", data, lastGoodData: data, source: "test", fetchedAt: now,
    staleAt: now + 60000, error: null, attempts: [] };
}
function selection(overrides: Partial<OptionsEnrichmentSelection> = {}): OptionsEnrichmentSelection {
  return { instrument, expiration: selected, selectedEntry: ready(chain()), catalogue: [selected, next],
    spot: 100, spotAsOf: now - 1000, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("options enrichment projection", () => {
  test("matches a provider's bare underlying to a public listing key while retaining its cache scope", () => {
    const scoped = { ...instrument, symbol: "AAPL:XNAS" };
    const result = projectOptionsEnrichment({ ...selection({ instrument: scoped }), curve, neighbourEntry: ready(chain(next)), now });
    expect(result.error).toBeNull();
    expect(result.expectedMove.straddle).toBeGreaterThan(0);
    expect(result.termSlope).not.toBeNull();
    expect(result.key).toBe(buildOptionsKey({ instrument: scoped, expirationDate: selected }));
    expect(result.key).not.toBe(buildOptionsKey({ instrument, expirationDate: selected }));
  });

  test("uses cleaned recomputed IV for moves and adjacent slope with dated instrument identity", () => {
    const result = projectOptionsEnrichment({ ...selection(), curve, neighbourEntry: ready(chain(next, 0.4)), now });
    expect(result.key).toBe(buildOptionsKey({ instrument, expirationDate: selected }));
    expect(result.phase).toBe("ready");
    expect(result.expectedMove.sigma).toBeCloseTo(100 * 0.3 * Math.sqrt(daysToExpiryFrom(selected, now) / 365), 4);
    const pair = chain();
    expect(result.expectedMove.straddle).toBeCloseTo(pair.calls[6]!.lastPrice / 2 + pair.puts[6]!.lastPrice / 2, 8);
    expect(result.expectedMove.straddlePercent).toBeCloseTo(result.expectedMove.straddle!, 10);
    expect(result.skew25).toBeCloseTo(0, 4);
    expect(result.termSlope).toBeCloseTo(0.1 / ((daysToExpiryFrom(next, now) - daysToExpiryFrom(selected, now)) / 365), 4);
    expect(result.source).toBe("test");
    expect(result.asOf).toBe("2026-09-22T13:45:00Z");
    expect(result.neighbourAsOf).toBe(result.asOf);
    expect(result.rateAsOf).toEqual(["2026-09-21"]);
    const skewed = projectOptionsEnrichment({ ...selection({ selectedEntry: ready(chain(selected, (strike) => 0.3 - (strike - 100) * 0.002)) }),
      curve, neighbourEntry: ready(chain(next)), now });
    expect(skewed.skew25!).toBeGreaterThan(0.02);
    expect(skewed.skew25!).toBeLessThan(0.1);
  });

  test("keeps the quote-only straddle when Treasury fails and never replaces zero bids with last trades", () => {
    const result = projectOptionsEnrichment({ ...selection(), curve: [], treasuryError: "offline",
      neighbourEntry: ready(chain(next)), now });
    expect(result.phase).toBe("partial");
    expect(result.expectedMove.straddle).toBeGreaterThan(0);
    expect(result.expectedMove.sigma).toBeNull();
    expect(result.skew25).toBeNull();
    expect(result.termSlope).toBeNull();
    expect(result.error).toContain("Treasury: offline");
    const zeroBid = chain();
    zeroBid.calls = zeroBid.calls.map((contract) => ({ ...contract, bid: 0 }));
    zeroBid.puts = zeroBid.puts.map((contract) => ({ ...contract, bid: 0 }));
    const rejected = projectOptionsEnrichment({ ...selection({ selectedEntry: ready(zeroBid) }), curve, neighbourEntry: ready(chain(next)), now });
    expect(rejected.phase).toBe("unavailable");
    expect(rejected.expectedMove.straddle).toBeNull();
    expect(rejected.expectedMove.sigma).toBeNull();
  });

  test("refuses removed, expired, mismatched, stale, failed and undated selections", () => {
    const good = selection();
    const mixed = chain(); mixed.puts[0]!.expiration = next;
    const cases: Partial<OptionsEnrichmentSelection>[] = [
      { catalogue: [] }, { expiration: expiry(-1), catalogue: [expiry(-1)] },
      { selectedEntry: ready(chain(next)) }, { selectedEntry: ready(mixed) },
      { selectedEntry: ready({ ...chain(), underlyingSymbol: "MSFT" }) },
      { selectedEntry: { ...good.selectedEntry, staleAt: now } },
      { selectedEntry: { ...good.selectedEntry, error: { reasonCode: "UPSTREAM_ERROR", message: "refresh failed" } } },
      { selectedEntry: ready({ ...chain(), asOf: undefined }) }, { spot: NaN },
    ];
    for (const patch of cases) {
      const result = projectOptionsEnrichment({ ...good, ...patch, curve, neighbourEntry: ready(chain(next)), now });
      expect(result.phase).toBe("unavailable");
      expect(result.error).toBeTruthy();
      expect(result.expectedMove.straddle).toBeNull();
      expect(result.skew25).toBeNull();
      expect(result.termSlope).toBeNull();
    }
    const other = projectOptionsEnrichment({ ...good, instrument: { ...instrument, brokerInstanceId: "other-account" }, now });
    expect(other.key).not.toBe(buildOptionsKey({ instrument, expirationDate: selected }));
  });

  test("missing or stale adjacent quotes only remove slope and never jump over the nearest tenor", () => {
    const neighbour = ready(chain(next));
    for (const entry of [null, { ...neighbour, staleAt: now }, ready({ ...chain(next), asOf: undefined }),
      ready(chain(selected)), ready({ ...chain(next), underlyingSymbol: "MSFT" })]) {
      const result = projectOptionsEnrichment({ ...selection({ catalogue: [expiry(120), next, selected, next] }),
        curve, neighbourEntry: entry, now });
      expect(result.neighbourExpiration).toBe(next);
      expect(result.termSlope).toBeNull();
      expect(result.expectedMove.sigma).toBeGreaterThan(0);
      expect(result.error).toContain("Adjacent expiry");
    }
    expect(optionsEnrichmentNeighbour([NaN, selected, next, selected, expiry(-1)], selected, now)).toBe(next);
    const last = projectOptionsEnrichment({ ...selection({ catalogue: [selected] }), curve, now });
    expect(last.neighbourExpiration).toBeNull();
    expect(last.termSlope).toBeNull();
    expect(last.phase).toBe("ready");
  });

  test("retains both source dates and flags a slope crossing observation dates", () => {
    const result = projectOptionsEnrichment({ ...selection(), curve, now,
      neighbourEntry: ready({ ...chain(next), asOf: "2026-09-21T20:00:00Z", providerId: "other-source" }) });
    expect(result.termSlope).not.toBeNull();
    expect(result.asOf).toBe("2026-09-22T13:45:00Z");
    expect(result.neighbourAsOf).toBe("2026-09-21T20:00:00Z");
    expect(result.neighbourSource).toBe("other-source");
    expect(result.warnings.some((warning) => warning.includes("different dates"))).toBe(true);
  });
});

describe("options enrichment loading", () => {
  test("publishes quoted then modeled selected metrics before the adjacent request completes", async () => {
    const rateGate = deferred<typeof curve>();
    const neighbourGate = deferred<QueryEntry<OptionsChain>>();
    const snapshots: OptionsEnrichmentSnapshot[] = [];
    const calls: { expiration?: number; force?: boolean; instrument: unknown }[] = [];
    const loading = loadOptionsEnrichment({ ...selection(), forceRefresh: true, onSnapshot: (value) => snapshots.push(value) }, {
      now: () => now, loadYieldCurve: () => rateGate.promise, loadOptions: async (request, options) => {
        calls.push({ expiration: request.expirationDate, force: options?.forceRefresh, instrument: request.instrument });
        return neighbourGate.promise;
      },
    });
    expect(snapshots[0]!.expectedMove.straddle).toBeGreaterThan(0);
    expect(snapshots[0]!.expectedMove.sigma).toBeNull();
    rateGate.resolve(curve); await settle();
    expect(snapshots.at(-1)!.expectedMove.sigma).toBeGreaterThan(0);
    expect(snapshots.at(-1)!.termSlope).toBeNull();
    expect(snapshots.at(-1)!.phase).toBe("partial");
    neighbourGate.resolve(ready(chain(next, 0.4)));
    const result = await loading;
    expect(result.phase).toBe("ready");
    expect(result.termSlope).not.toBeNull();
    expect(calls).toEqual([{ expiration: next, force: true, instrument }]);
    expect(snapshots[0]!.expectedMove.sigma).toBeNull();
  });

  test("uses an OMON-selected expiry outside the surface sample and shares its adjacent cache entry", async () => {
    const catalogue = Array.from({ length: 120 }, (_, index) => expiry(index + 1));
    const representative = selectSurfaceExpiries(catalogue, 18, now);
    const expiration = catalogue.find((date) => date >= expiry(30) && !representative.includes(date))!;
    const neighbour = optionsEnrichmentNeighbour(catalogue, expiration, now)!;
    const calls: (number | undefined)[] = [];
    const provider = { id: "test", getOptionsChain: async (_symbol: string, _exchange: string, requested?: number) => {
      calls.push(requested); return { ...chain(requested), expirationDates: catalogue };
    } } as unknown as DataProvider;
    const coordinator = new MarketDataCoordinator(provider);
    const selectedEntry = await coordinator.loadOptions({ instrument, expirationDate: expiration });
    await coordinator.loadOptions({ instrument, expirationDate: neighbour });
    const result = await loadOptionsEnrichment(selection({ expiration, selectedEntry, catalogue }), {
      now: () => now, loadYieldCurve: async () => curve, loadOptions: coordinator.loadOptions.bind(coordinator),
    });
    expect(result.expiration).toBe(expiration);
    expect(result.expectedMove.sigma).toBeGreaterThan(0);
    expect(calls).toEqual([expiration, neighbour]);
  });

  test("does not fetch for invalid selected state and preserves partial quote data on independent failures", async () => {
    let calls = 0;
    const dependencies = { now: () => now, loadYieldCurve: async () => { calls += 1; throw new Error("rates offline"); },
      loadOptions: async () => { calls += 1; throw new Error("neighbor offline"); } };
    const invalid = await loadOptionsEnrichment(selection({ catalogue: [] }), dependencies);
    expect(invalid.phase).toBe("unavailable");
    expect(calls).toBe(0);
    const partial = await loadOptionsEnrichment(selection(), dependencies);
    expect(partial.phase).toBe("partial");
    expect(partial.expectedMove.straddle).toBeGreaterThan(0);
    expect(partial.error).toContain("rates offline");
    expect(partial.error).toContain("neighbor offline");
    expect(calls).toBe(2);
  });

  test("cancellation rejects promptly and prevents late snapshots or new dependency calls", async () => {
    const gate = deferred<QueryEntry<OptionsChain>>();
    const snapshots: OptionsEnrichmentSnapshot[] = [];
    let calls = 0;
    const dependencies = { now: () => now, loadYieldCurve: async () => curve,
      loadOptions: async () => { calls += 1; return gate.promise; } };
    const controller = new AbortController();
    const loading = loadOptionsEnrichment({ ...selection(), signal: controller.signal, onSnapshot: (value) => snapshots.push(value) }, dependencies);
    await settle(); controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    const count = snapshots.length;
    gate.resolve(ready(chain(next))); await settle();
    expect(snapshots).toHaveLength(count);
    expect(calls).toBe(1);
    await expect(loadOptionsEnrichment({ ...selection(), signal: controller.signal }, dependencies)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    const immediate = new AbortController();
    const superseded = loadOptionsEnrichment({ ...selection(), signal: immediate.signal }, dependencies);
    immediate.abort();
    await expect(superseded).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
});
