import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../../../data/fred-series";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import {
  createValuationSeriesLoader,
  loadValuationBundle,
  requiredSeries,
  type ValuationSeriesLoader,
} from "./client";
import { BUFFETT_INDICATOR, TOBINS_Q } from "./indicators";
import type { IndicatorDef } from "./defs";
import type { DatedSeries } from "./series";

function dated(
  seriesId: string,
  observations: Array<{ date: string; value: number }>,
  provenance: DatedSeries["provenance"] = "fred",
): DatedSeries {
  return { seriesId, observations, provenance };
}

function cachePayload(seriesId: string, observations: Array<{ date: string; value: number }>) {
  return {
    observations,
    info: {
      id: seriesId,
      title: seriesId,
      units: "Billions of Dollars",
      frequency: "Quarterly",
      seasonalAdjustment: "Seasonally Adjusted Annual Rate",
      source: "FRED",
      notes: "",
    },
  };
}

const wilshireObs = [
  { date: "2024-01-02", value: 40_000 },
  { date: "2024-04-02", value: 42_000 },
  { date: "2025-01-02", value: 45_000 },
];
const gdpObs = [
  { date: "2024-01-01", value: 25_000 },
  { date: "2024-04-01", value: 25_500 },
  { date: "2025-01-01", value: 26_000 },
];
const zOneObs = [
  { date: "2024-01-01", value: 60_000_000 },
  { date: "2024-04-01", value: 62_000_000 },
  { date: "2025-01-01", value: 64_000_000 },
];
const zTwoObs = [
  { date: "2024-01-01", value: 40_000_000 },
  { date: "2024-04-01", value: 40_500_000 },
  { date: "2025-01-01", value: 41_000_000 },
];

const OBSERVATIONS: Record<string, Array<{ date: string; value: number }>> = {
  WILL5000PRFC: wilshireObs,
  GDP: gdpObs,
  NCBEILQ027S: zOneObs,
  TNWMVBSNNCB: zTwoObs,
};

const everySeriesLoader: ValuationSeriesLoader = async (def) => {
  const observations = OBSERVATIONS[def.seriesId];
  if (!observations) throw new Error(`unexpected ${def.seriesId}`);
  return dated(def.seriesId, observations);
};

beforeEach(resetFredSeriesPersistence);
afterEach(resetFredSeriesPersistence);

describe("requiredSeries", () => {
  test("fetches a leg shared by two indicators only once", () => {
    const shared: IndicatorDef = { ...TOBINS_Q, id: "shared", denominator: BUFFETT_INDICATOR.denominator };
    const ids = requiredSeries([BUFFETT_INDICATOR, shared]).map((def) => def.seriesId);
    expect(ids).toEqual(["WILL5000PRFC", "GDP", "NCBEILQ027S"]);
  });
});

describe("loadValuationBundle", () => {
  test("builds every indicator with its own fixed request limits", async () => {
    const requests: Array<{ seriesId: string; limit?: number; sortOrder?: string }> = [];
    const bundle = await loadValuationBundle({
      force: true,
      loader: async (def) => {
        requests.push({
          seriesId: def.seriesId,
          limit: def.request.limit,
          sortOrder: def.request.sortOrder,
        });
        return everySeriesLoader(def);
      },
    });

    expect(bundle.builds.map((build) => build.indicator.id)).toEqual(["buffett", "tobins-q"]);
    expect(requests.map((r) => r.seriesId).sort()).toEqual([
      "GDP",
      "NCBEILQ027S",
      "TNWMVBSNNCB",
      "WILL5000PRFC",
    ]);
    for (const request of requests) expect(request.sortOrder).toBe("desc");
    expect(requests.find((r) => r.seriesId === "WILL5000PRFC")!.limit).toBe(10000);
    expect(requests.find((r) => r.seriesId === "GDP")!.limit).toBe(340);
  });

  test("one broken indicator does not take down the rest", async () => {
    const bundle = await loadValuationBundle({
      force: true,
      loader: async (def) => {
        if (def.seriesId === "WILL5000PRFC") throw new Error("Unsupported FRED series");
        return everySeriesLoader(def);
      },
    });
    expect(bundle.builds.map((build) => build.indicator.id)).toEqual(["tobins-q"]);
    expect(bundle.errors.join(" ")).toContain("WILL5000PRFC");
  });

  test("throws when nothing builds", async () => {
    await expect(loadValuationBundle({
      force: true,
      loader: async () => { throw new Error("offline"); },
    })).rejects.toThrow("offline");
  });

  test("default loader takes Yahoo for the index leg and FRED CSV after an allowlist rejection", async () => {
    const cloud: string[] = [];
    const yahoo: string[] = [];
    const csv: string[] = [];
    const loader = createValuationSeriesLoader({
      loadCloudFred: async (request) => {
        cloud.push(request.seriesId);
        throw new Error("Unsupported FRED series");
      },
      loadYahooIndex: async (symbol, seriesId) => {
        yahoo.push(`${symbol}:${seriesId}`);
        return dated(seriesId, wilshireObs, "yahoo");
      },
      loadFredCsv: async (seriesId) => {
        csv.push(seriesId);
        return dated(seriesId, OBSERVATIONS[seriesId]!, "fred-csv");
      },
    });

    const bundle = await loadValuationBundle({ force: true, loader });
    expect(yahoo).toEqual(["^W5000:WILL5000PRFC"]);
    expect(cloud.sort()).toEqual(["GDP", "NCBEILQ027S", "TNWMVBSNNCB"]);
    expect(csv.sort()).toEqual(["GDP", "NCBEILQ027S", "TNWMVBSNNCB"]);
    expect(bundle.builds).toHaveLength(2);
  });

  test("does not fall back to FRED CSV on a non-allowlist cloud error", async () => {
    const loader = createValuationSeriesLoader({
      loadCloudFred: async () => { throw new Error("offline"); },
      loadYahooIndex: async (_symbol, seriesId) => dated(seriesId, wilshireObs, "yahoo"),
      loadFredCsv: async () => { throw new Error("csv should not run"); },
    });
    await expect(loadValuationBundle({ force: true, loader })).rejects.toThrow("offline");
  });

  test("serves seeded cache keys without touching the network", async () => {
    const persistence = new MemoryPluginPersistence();
    const meta = { sourceKey: "gloomberb-cloud", schemaVersion: 1 } as const;
    persistence.seedResource("fred-series", "WILL5000PRFC:limit=10000:sort=desc", cachePayload("WILL5000PRFC", wilshireObs), meta);
    persistence.seedResource("fred-series", "GDP:limit=340:sort=desc", cachePayload("GDP", gdpObs), meta);
    persistence.seedResource("fred-series", "NCBEILQ027S:limit=400:sort=desc", cachePayload("NCBEILQ027S", zOneObs), meta);
    persistence.seedResource("fred-series", "TNWMVBSNNCB:limit=400:sort=desc", cachePayload("TNWMVBSNNCB", zTwoObs), meta);
    attachFredSeriesPersistence(persistence);

    let calls = 0;
    const bundle = await loadValuationBundle({
      force: false,
      loader: async () => { calls += 1; throw new Error("should not hit network"); },
    });
    expect(calls).toBe(0);
    expect(bundle.builds.map((build) => build.indicator.id)).toEqual(["buffett", "tobins-q"]);
  });
});
