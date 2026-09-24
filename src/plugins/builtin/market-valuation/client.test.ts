import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachValuationPersistence, loadCachedSeries, resetValuationPersistence } from "./cache";
import { createValuationSeriesLoader, getCachedValuationBundle, loadValuationBundle, requiredSeries, type ValuationSeriesLoader } from "./client";
import { BUFFETT_INDICATOR, INDICATORS, EXCESS_CAPE_YIELD, SHILLER_CAPE, TOBINS_Q } from "./indicators";
import type { DatedObservation, DatedSeries } from "./series";
import { buildValuationSeries } from "./align";
import { resolveValuationSeries } from "./chart-series";
import { createCloudSourceDeps, createSourceLoader, shillerObservations, sumFredSeries } from "./sources";

function obs(values: Array<[string, number]>): DatedObservation[] {
  return values.map(([date, value]) => ({ date, value }));
}

const LEGS: Record<string, DatedObservation[]> = {
  Z1_CORPORATE_EQUITIES: obs([["2024-01-01", 40_000_000], ["2025-01-01", 45_500_000]]),
  GDP: obs([["2024-01-01", 25_000], ["2025-01-01", 26_000]]),
  M2SL: obs([["2024-01-01", 20_000], ["2025-01-01", 21_000]]),
  NCBEILQ027S: obs([["2024-01-01", 60_000_000], ["2025-01-01", 64_000_000]]),
  TNWMVBSNNCB: obs([["2024-01-01", 40_000_000], ["2025-01-01", 41_000_000]]),
  BOGZ1FL153064486Q: obs([["2024-01-01", 38], ["2025-01-01", 45.8]]),
  BOGZ1FL663067003Q: obs([["2024-01-01", 600000], ["2025-01-01", 650000]]),
  CPROFIT: obs([["2024-01-01", 3400], ["2025-01-01", 4800]]),
  SHILLER_CAPE: obs([["2024-01-01", 33.2], ["2025-01-01", 38.1]]),
  SHILLER_ECY: obs([["2024-01-01", 0.021], ["2025-01-01", 0.013]]),
  SHILLER_DIVIDEND: obs([["2024-01-01", 70], ["2025-01-01", 78]]),
  SHILLER_PRICE: obs([["2024-01-01", 4800], ["2025-01-01", 6000]]),
};

const everyLeg: ValuationSeriesLoader = async (def) => {
  const observations = LEGS[def.key];
  if (!observations) throw new Error(`unexpected ${def.key}`);
  return { seriesId: def.key, observations, provenance: "fred" } satisfies DatedSeries;
};

beforeEach(() => {
  resetValuationPersistence();
  attachValuationPersistence(new MemoryPluginPersistence());
});
afterEach(resetValuationPersistence);

describe("requiredSeries", () => {
  test("fetches a leg shared by two indicators only once", () => {
    const keys = requiredSeries([TOBINS_Q, TOBINS_Q, BUFFETT_INDICATOR]).map((def) => def.key);
    expect(keys.filter((key) => key === "NCBEILQ027S")).toHaveLength(1);
    expect(keys).toContain("Z1_CORPORATE_EQUITIES");
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("loadValuationBundle", () => {
  test("builds every indicator, with the three market-cap ratios sharing the Z.1 equities numerator", async () => {
    const requested: string[] = [];
    const bundle = await loadValuationBundle({ loader: async (def) => {
      requested.push(def.key);
      return everyLeg(def);
    } });
    expect(requested.filter((key) => key === "Z1_CORPORATE_EQUITIES")).toHaveLength(1);
    expect(bundle.builds.map((build) => build.indicator.id)).toEqual(INDICATORS.map((indicator) => indicator.id));
    expect(bundle.builds.find((build) => build.indicator.id === "shiller-cape")!.series.points.at(-1)!.ratio).toBe(38.1);
    expect(bundle.builds.find((build) => build.indicator.id === "tobins-q")!.series.points.at(-1)!.ratio).toBeCloseTo(64 / 41);
    // 45.5T of equities against 26.0T of GDP, both in billions after scaling.
    expect(bundle.builds.find((build) => build.indicator.id === "buffett")!.series.points.at(-1)).toMatchObject({
      ratio: 175, numeratorBillions: 45_500, denominatorBillions: 26_000,
    });
    expect(bundle.errors).toHaveLength(0);
  });

  test("one broken leg only drops the indicators that need it", async () => {
    const bundle = await loadValuationBundle({
      loader: async (def) => {
        if (def.key === "NCBEILQ027S") throw new Error("FRED unavailable");
        return everyLeg(def);
      },
    });
    const ids = bundle.builds.map((build) => build.indicator.id);
    expect(ids).not.toContain("tobins-q");
    expect(ids).toContain("shiller-cape");
    expect(bundle.errors.join(" ")).toContain("FRED unavailable");
  });

  test("throws when nothing builds", async () => {
    await expect(loadValuationBundle({
      loader: async () => { throw new Error("offline"); },
    })).rejects.toThrow("offline");
  });
});

describe("createSourceLoader", () => {
  test("fetches the Shiller dataset once for every column that needs it", async () => {
    let shillerCalls = 0;
    const loader = createSourceLoader({
      loadFred: async () => obs([["2024-01-01", 1]]),
      loadMarketHistory: async () => obs([["2024-01-01", 1]]),
      loadShiller: async () => {
        shillerCalls += 1;
        return {
          observations: [
            { date: "2026-08-01", price: 7600, dividend: 81, earnings: null, cpi: 333, longRate: 4.75, cape: 41.2, excessCapeYield: 0.0097 },
          ],
          sourceUrl: "https://example.test/ie_data.xls",
          fetchedAt: "2026-09-02T00:00:00.000Z",
        };
      },
    });

    const shillerLegs = requiredSeries(INDICATORS)
      .filter((def) => def.source.kind === "shiller");
    expect(shillerLegs.length).toBeGreaterThan(1);
    const loaded = await Promise.all(shillerLegs.map((def) => loader(def)));
    expect(shillerCalls).toBe(1);
    expect(loaded.every((entry) => entry.observations.length === 1)).toBe(true);
  });

  test("routes each source kind to its own transport and sums the Z.1 legs on shared dates", async () => {
    const seen: string[] = [];
    const loader = createSourceLoader({
      loadFred: async (seriesId) => {
        seen.push(`fred:${seriesId}`);
        return seriesId === "FBCELLQ027S"
          ? { observations: obs([["2024-01-01", 10], ["2025-01-01", 12]]), provider: { fetchedAt: "2026-09-10T00:00:00Z", stale: true } }
          : { observations: obs([["2024-01-01", 30], ["2025-01-01", 32], ["2025-04-01", 33]]), provider: { fetchedAt: "2026-09-12T00:00:00Z", stale: false } };
      },
      loadMarketHistory: async (symbol) => { seen.push(`history:${symbol}`); return obs([["2024-01-01", 1]]); },
      loadShiller: async () => { throw new Error("not needed"); },
    });
    if (BUFFETT_INDICATOR.input.kind !== "ratio") throw new Error("expected a ratio");
    const equities = await loader(BUFFETT_INDICATOR.input.numerator);
    await loader(BUFFETT_INDICATOR.input.denominator);
    if (TOBINS_Q.input.kind !== "ratio") throw new Error("expected a ratio");
    await loader(TOBINS_Q.input.numerator);
    expect(seen).toEqual(["fred:NCBEILQ027S", "fred:FBCELLQ027S", "fred:GDP", "fred:NCBEILQ027S"]);
    // The quarter only one leg has released is not an observation of the sum.
    expect(equities.observations).toEqual(obs([["2024-01-01", 40], ["2025-01-01", 44]]));
    expect(equities.provider).toEqual({ fetchedAt: "2026-09-10T00:00:00Z", stale: true });
    expect(equities.provenance).toBe("fred");
  });

  test("a sum with no shared dates is an error, not an empty series", () => {
    expect(() => sumFredSeries([obs([["2024-01-01", 1]]), obs([["2025-01-01", 1]])])).toThrow("share no observation dates");
  });
});

describe("shillerObservations", () => {
  test("keeps a column's nulls rather than dropping the month", () => {
    const observations = shillerObservations({
      observations: [
        { date: "2026-07-01", price: 7481, dividend: null, earnings: null, cpi: 333, longRate: 4.6, cape: 40.6, excessCapeYield: 0.0118 },
        { date: "2026-08-01", price: 7600, dividend: 81, earnings: null, cpi: 333, longRate: 4.75, cape: 41.2, excessCapeYield: 0.0097 },
      ],
      sourceUrl: "x",
      fetchedAt: "y",
    }, "dividend");
    expect(observations.map((entry) => entry.value)).toEqual([null, 81]);
  });

  test("throws when a column is entirely empty", () => {
    expect(() => shillerObservations({
      observations: [
        { date: "2026-08-01", price: 7600, dividend: null, earnings: null, cpi: null, longRate: null, cape: null, excessCapeYield: null },
      ],
      sourceUrl: "x",
      fetchedAt: "y",
    }, "earnings")).toThrow("no earnings observations");
  });
});


describe("market-capitalization source basis", () => {
  test("a legacy persisted index-points cache cannot feed the monetary ratios; the Z.1 sum does", async () => {
    await loadCachedSeries("W5000", async () => obs([["2024-01-02", 40_000], ["2025-01-02", 45_000]]));
    await Promise.all(Object.entries(LEGS).map(([key, observations]) => loadCachedSeries(key, async () => observations)));
    const cached = getCachedValuationBundle()!;
    expect(cached.builds).toHaveLength(INDICATORS.length);
    expect(cached.errors).toHaveLength(0);
    expect(cached.sources.W5000).toBeUndefined();
    const legs = new Map(Object.entries(LEGS).map(([seriesId, observations]) => [seriesId, { seriesId, observations, provenance: "fred" as const }]));
    for (const id of ["buffett", "market-cap-profits", "market-cap-m2"]) {
      const indicator = INDICATORS.find((entry) => entry.id === id)!;
      expect(buildValuationSeries(indicator, legs).points.at(-1)!.numeratorBillions).toBe(45_500);
      const chart = await resolveValuationSeries(id, everyLeg);
      expect(chart.points.at(-1)!.value).toBeGreaterThan(0);
    }
    const cape = await resolveValuationSeries("shiller-cape", everyLeg);
    expect(cape.points.at(-1)!.value).toBe(38.1);
    const allocation = await resolveValuationSeries("household-equity-allocation", everyLeg);
    expect(allocation.points.at(-1)!.value).toBe(45.8);
    expect(allocation.unit).toBe("%");
    expect(allocation.unitGroup).toBe("valuation-percent");
    expect(cape.unit).toBe("x");
  });
});


test("refresh bypasses fresh caches, shares pending Shiller work and retains failed-refresh provenance until success", async () => {
  let now = Date.parse("2026-09-14T12:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let calls = 0;
  let cape = 30;
  let date = "2026-09-01";
  let failing = false;
  const loader = createValuationSeriesLoader({
    loadFred: async () => { throw new Error("unexpected FRED"); },
    loadMarketHistory: async () => { throw new Error("unexpected history"); },
    loadShiller: async () => {
      calls += 1;
      if (failing) throw new Error("Shiller refresh unavailable");
      return { observations: [{ date, price: 100, dividend: 2,
        earnings: 5, cpi: 300, longRate: 4, cape, excessCapeYield: 0 }],
        sourceUrl: "controlled:shiller", fetchedAt: new Date(now).toISOString() };
    },
  });
  const indicators = [SHILLER_CAPE, EXCESS_CAPE_YIELD];
  const load = (force = false) => loadValuationBundle({ loader, indicators, force });
  try {
    const initial = await load();
    await load();
    expect(calls).toBe(1);
    expect(initial.fetchedAt).toBe(now);
    now += 1000; cape = 40;
    const revised = await load(true);
    expect(calls).toBe(2);
    expect(revised.builds[0]!.series.points.at(-1)!.ratio).toBe(40);
    expect(revised.fetchedAt).toBe(now);
    now += 1000; failing = true;
    const failed = await load(true);
    expect(calls).toBe(3);
    expect(failed.fetchedAt).toBe(revised.fetchedAt);
    expect(failed.errors.join(" ")).toContain("Shiller refresh unavailable");
    expect(failed.sources!.SHILLER_CAPE).toMatchObject({ stale: true, source: "stale-fallback", fetchedAt: revised.fetchedAt });
    const cached = await load();
    expect(calls).toBe(3);
    expect(cached.errors).toEqual(failed.errors);
    expect(getCachedValuationBundle(indicators)!.errors).toEqual(failed.errors);
    expect(getCachedValuationBundle(indicators)!.builds[0]!.sourceStale).toBe(true);
    now += 1000; failing = false; cape = 50;
    const recovered = await load(true);
    expect(calls).toBe(4);
    expect(recovered.errors).toEqual([]);
    expect(recovered.sources!.SHILLER_CAPE).toMatchObject({ stale: false, source: "network", fetchedAt: now });
    now += 6 * 60 * 60 * 1000 + 1; cape = 60;
    // A cache past its refresh time is revalidated, not late at the source.
    expect(getCachedValuationBundle(indicators)!.builds[0]!.sourceStale).toBe(false);
    const expired = await load();
    expect(calls).toBe(5);
    expect(expired.builds[0]!.series.points.at(-1)!.ratio).toBe(60);
    expect(expired.fetchedAt).toBe(now);
    date = "2026-02-30";
    const invalid = await load(true);
    expect(invalid.errors.join(" ")).toContain("Invalid observation date: 2026-02-30");
    expect(invalid.builds[0]!.series.points.at(-1)!.date).toBe("2026-09-01");
    expect(invalid.sources!.SHILLER_CAPE).toMatchObject({ stale: true, source: "stale-fallback", fetchedAt: expired.fetchedAt });
  } finally {
    clock.mockRestore();
  }
});


test("cloud-declared stale legs remain usable and stale after a cache restart", async () => {
  const persistence = new MemoryPluginPersistence();
  attachValuationPersistence(persistence);
  let calls = 0;
  const loader = createValuationSeriesLoader(createCloudSourceDeps({
    getCloudFredSeries: async (id) => {
      calls += 1;
      return { info: null, observations: [{ date: "2026-07-01", value: id === "NCBEILQ027S" ? 100 : 50 }],
        fetchedAt: "2026-09-10T12:00:00Z", stale: id === "TNWMVBSNNCB" };
    },
    getCloudShiller: async () => { throw new Error("unexpected Shiller"); },
    getCloudHistory: async () => { throw new Error("unexpected history"); },
  }));
  const bundle = await loadValuationBundle({ loader, indicators: [TOBINS_Q] });
  expect(bundle.builds[0]!.sourceStale).toBe(true);
  expect(bundle.builds[0]!.series.points.at(-1)!.ratio).toBe(2);
  expect(bundle.sources!.TNWMVBSNNCB!.provider).toEqual({ fetchedAt: "2026-09-10T12:00:00Z", stale: true });
  resetValuationPersistence();
  attachValuationPersistence(persistence);
  const cached = await loadValuationBundle({ loader, indicators: [TOBINS_Q] });
  expect(calls).toBe(2);
  expect(cached.builds[0]!.sourceStale).toBe(true);
  expect(cached.sources!.TNWMVBSNNCB!.provider).toEqual(bundle.sources!.TNWMVBSNNCB!.provider);
  expect((await resolveValuationSeries("tobins-q", loader)).warning).toContain("source data is stale");
});
