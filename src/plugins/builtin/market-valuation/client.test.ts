import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachValuationPersistence, resetValuationPersistence } from "./cache";
import { loadValuationBundle, requiredSeries, type ValuationSeriesLoader } from "./client";
import { BUFFETT_INDICATOR, INDICATORS, SHILLER_CAPE, TOBINS_Q } from "./indicators";
import type { DatedObservation, DatedSeries } from "./series";
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
    // Buffett and Cap/M2 share the Wilshire leg.
    const keys = requiredSeries(INDICATORS).map((def) => def.key);
    expect(keys.filter((key) => key === "W5000")).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("loadValuationBundle", () => {
  test("builds every registered indicator", async () => {
    const bundle = await loadValuationBundle({ loader: everyLeg });
    expect(bundle.builds.map((build) => build.indicator.id))
      .toEqual(INDICATORS.map((indicator) => indicator.id));
  });

  test("one broken leg only drops the indicators that need it", async () => {
    const bundle = await loadValuationBundle({
      loader: async (def) => {
        if (def.key === "W5000") throw new Error("history unavailable");
        return everyLeg(def);
      },
    });
    const ids = bundle.builds.map((build) => build.indicator.id);
    expect(ids).not.toContain("buffett");
    expect(ids).not.toContain("market-cap-m2");
    expect(ids).toContain("shiller-cape");
    expect(bundle.errors.join(" ")).toContain("W5000");
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
