import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachValuationPersistence, loadCachedSeries, resetValuationPersistence } from "./cache";
import { createValuationSeriesLoader, getCachedValuationBundle, loadValuationBundle, requiredSeries, type ValuationSeriesLoader } from "./client";
import { BUFFETT_INDICATOR, INDICATORS, SHILLER_CAPE, TOBINS_Q } from "./indicators";
import type { DatedObservation, DatedSeries } from "./series";
import { buildValuationSeries } from "./align";
import { resolveValuationSeries } from "./chart-series";
import { createSourceLoader, shillerObservations } from "./sources";

function obs(values: Array<[string, number]>): DatedObservation[] {
  return values.map(([date, value]) => ({ date, value }));
}

const LEGS: Record<string, DatedObservation[]> = {
  W5000: obs([["2024-01-02", 40_000], ["2025-01-02", 45_000]]),
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
    expect(keys).not.toContain("W5000");
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("loadValuationBundle", () => {
  test("does not fetch or compute unsupported monetary inputs, leaving six independent measures", async () => {
    const requested: string[] = [];
    const bundle = await loadValuationBundle({ loader: async (def) => {
      requested.push(def.key);
      return everyLeg(def);
    } });
    expect(requested).not.toContain("W5000");
    expect(requested).not.toContain("CPROFIT");
    expect(requested).not.toContain("M2SL");
    expect(bundle.builds.map((build) => build.indicator.id)).toEqual([
      "shiller-cape", "excess-cape-yield", "tobins-q", "household-equity-allocation",
      "sp500-dividend-yield", "margin-debt-gdp",
    ]);
    expect(bundle.builds.find((build) => build.indicator.id === "shiller-cape")!.series.points.at(-1)!.ratio).toBe(38.1);
    expect(bundle.builds.find((build) => build.indicator.id === "tobins-q")!.series.points.at(-1)!.ratio).toBeCloseTo(64 / 41);
    expect(bundle.errors).toHaveLength(3);
    expect(bundle.errors.every((error) => error.includes("index points"))).toBe(true);
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

  test("routes each source kind to its own transport", async () => {
    const seen: string[] = [];
    const loader = createSourceLoader({
      loadFred: async (seriesId) => { seen.push(`fred:${seriesId}`); return obs([["2024-01-01", 1]]); },
      loadMarketHistory: async (symbol) => { seen.push(`history:${symbol}`); return obs([["2024-01-01", 1]]); },
      loadShiller: async () => { throw new Error("not needed"); },
    });
    if (BUFFETT_INDICATOR.input.kind !== "ratio") throw new Error("expected a ratio");
    await loader(BUFFETT_INDICATOR.input.numerator);
    await loader(BUFFETT_INDICATOR.input.denominator);
    if (TOBINS_Q.input.kind !== "ratio") throw new Error("expected a ratio");
    await loader(TOBINS_Q.input.numerator);
    expect(seen).toEqual(["history:^W5000", "fred:GDP", "fred:NCBEILQ027S"]);
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
  test("legacy persisted index closes cannot revive any of the three monetary ratios", async () => {
    await Promise.all(Object.entries(LEGS).map(([key, observations]) => loadCachedSeries(key, async () => observations)));
    const cached = getCachedValuationBundle()!;
    expect(cached.builds).toHaveLength(6);
    expect(cached.errors).toHaveLength(3);
    const legs = new Map(Object.entries(LEGS).map(([seriesId, observations]) => [seriesId, { seriesId, observations, provenance: "fred" as const }]));
    for (const id of ["buffett", "market-cap-profits", "market-cap-m2"]) {
      const indicator = INDICATORS.find((entry) => entry.id === id)!;
      expect(() => buildValuationSeries(indicator, legs)).toThrow("index points");
      await expect(loadValuationBundle({ loader: everyLeg, indicators: [indicator] })).rejects.toThrow("dollar market capitalization");
      let calls = 0;
      await expect(resolveValuationSeries(id, async (def) => { calls += 1; return everyLeg(def); })).rejects.toThrow("index points");
      expect(calls).toBe(0);
    }
    const loader = createValuationSeriesLoader({
      loadFred: async () => { throw new Error("unexpected transport"); },
      loadMarketHistory: async () => { throw new Error("unexpected transport"); },
      loadShiller: async () => { throw new Error("unexpected transport"); },
    });
    if (BUFFETT_INDICATOR.input.kind !== "ratio") throw new Error("ratio expected");
    await expect(loader(BUFFETT_INDICATOR.input.numerator)).rejects.toThrow("index points");
    const cape = await resolveValuationSeries("shiller-cape", everyLeg);
    expect(cape.points.at(-1)!.value).toBe(38.1);
    const allocation = await resolveValuationSeries("household-equity-allocation", everyLeg);
    expect(allocation.points.at(-1)!.value).toBe(45.8);
    expect(allocation.unit).toBe("%");
    expect(allocation.unitGroup).toBe("valuation-percent");
    expect(cape.unit).toBe("x");
  });
});
