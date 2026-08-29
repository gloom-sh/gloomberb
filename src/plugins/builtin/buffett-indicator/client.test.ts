import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../../../data/fred-series";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createBuffettSeriesLoader, errorForMode, loadBuffettBundle } from "./client";
import type { BuffettSeriesLoader } from "./client";
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
const z1Obs = [
  { date: "2024-01-01", value: 5_000_000 },
  { date: "2024-04-01", value: 5_200_000 },
  { date: "2025-01-01", value: 5_500_000 },
];
const gdpObs = [
  { date: "2024-01-01", value: 25_000 },
  { date: "2024-04-01", value: 25_500 },
  { date: "2025-01-01", value: 26_000 },
];

beforeEach(resetFredSeriesPersistence);
afterEach(resetFredSeriesPersistence);

describe("loadBuffettBundle", () => {
  test("loader requests use fixed limits and never a range startDate", async () => {
    const requests: Array<{ seriesId: string; limit?: number; sortOrder?: string }> = [];
    const loader: BuffettSeriesLoader = async (def) => {
      requests.push({
        seriesId: def.seriesId,
        limit: def.request.limit,
        sortOrder: def.request.sortOrder,
      });
      if (def.seriesId === "WILL5000PRFC") return dated(def.seriesId, wilshireObs, "yahoo");
      if (def.seriesId === "NCBEILQ027S") return dated(def.seriesId, z1Obs);
      if (def.seriesId === "GDP") return dated(def.seriesId, gdpObs);
      throw new Error(`unexpected ${def.seriesId}`);
    };

    const bundle = await loadBuffettBundle({ force: true, loader });
    expect(Object.keys(bundle.modes).sort()).toEqual(["wilshire", "z1"]);
    expect(requests.map((r) => r.seriesId).sort()).toEqual([
      "GDP",
      "NCBEILQ027S",
      "WILL5000PRFC",
    ]);
    for (const request of requests) {
      expect(request.sortOrder).toBe("desc");
      if (request.seriesId === "WILL5000PRFC") expect(request.limit).toBe(10000);
      else expect(request.limit).toBe(340);
    }
  });

  test("degrades to one mode when a numerator fails", async () => {
    const loader: BuffettSeriesLoader = async (def) => {
      if (def.seriesId === "WILL5000PRFC") {
        throw new Error("Unsupported FRED series");
      }
      if (def.seriesId === "NCBEILQ027S") return dated(def.seriesId, z1Obs);
      if (def.seriesId === "GDP") return dated(def.seriesId, gdpObs);
      throw new Error(`unexpected ${def.seriesId}`);
    };
    const bundle = await loadBuffettBundle({ force: true, loader });
    expect(bundle.modes.z1).toBeDefined();
    expect(bundle.modes.wilshire).toBeUndefined();
  });

  test("default loader uses Yahoo for Wilshire and FRED CSV after an allowlist rejection", async () => {
    const cloud: string[] = [];
    const yahoo: string[] = [];
    const csv: string[] = [];
    const loader = createBuffettSeriesLoader({
      loadCloudFred: async (request) => {
        cloud.push(request.seriesId);
        if (request.seriesId === "GDP") return dated("GDP", gdpObs);
        throw new Error("Unsupported FRED series");
      },
      loadYahooIndex: async (symbol, seriesId) => {
        yahoo.push(`${symbol}:${seriesId}`);
        return dated(seriesId, wilshireObs, "yahoo");
      },
      loadFredCsv: async (seriesId) => {
        csv.push(seriesId);
        return dated(seriesId, z1Obs, "fred-csv");
      },
    });

    const bundle = await loadBuffettBundle({ force: true, loader });
    expect(yahoo).toEqual(["^W5000:WILL5000PRFC"]);
    expect(cloud.sort()).toEqual(["GDP", "NCBEILQ027S"]);
    expect(csv).toEqual(["NCBEILQ027S"]);
    expect(bundle.modes.wilshire).toBeDefined();
    expect(bundle.modes.z1).toBeDefined();
  });

  test("does not fall back to FRED CSV on a non-allowlist cloud error", async () => {
    const loader = createBuffettSeriesLoader({
      loadCloudFred: async (request) => {
        if (request.seriesId === "GDP") return dated("GDP", gdpObs);
        throw new Error("offline");
      },
      loadYahooIndex: async (_symbol, seriesId) => dated(seriesId, wilshireObs, "yahoo"),
      loadFredCsv: async () => {
        throw new Error("csv should not run");
      },
    });
    const bundle = await loadBuffettBundle({ force: true, loader });
    expect(bundle.modes.wilshire).toBeDefined();
    expect(bundle.modes.z1).toBeUndefined();
  });

  test("throws when every mode fails", async () => {
    await expect(loadBuffettBundle({
      force: true,
      loader: async () => {
        throw new Error("offline");
      },
    })).rejects.toThrow("offline");
  });

  test("reads seeded fred-series cache keys without range segments", async () => {
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource(
      "fred-series",
      "WILL5000PRFC:limit=10000:sort=desc",
      cachePayload("WILL5000PRFC", wilshireObs),
      { sourceKey: "gloomberb-cloud", schemaVersion: 1 },
    );
    persistence.seedResource(
      "fred-series",
      "NCBEILQ027S:limit=340:sort=desc",
      cachePayload("NCBEILQ027S", z1Obs),
      { sourceKey: "gloomberb-cloud", schemaVersion: 1 },
    );
    persistence.seedResource(
      "fred-series",
      "GDP:limit=340:sort=desc",
      cachePayload("GDP", gdpObs),
      { sourceKey: "gloomberb-cloud", schemaVersion: 1 },
    );
    attachFredSeriesPersistence(persistence);

    let calls = 0;
    const bundle = await loadBuffettBundle({
      force: false,
      loader: async () => {
        calls += 1;
        throw new Error("should not hit network");
      },
    });
    expect(calls).toBe(0);
    expect(bundle.modes.wilshire).toBeDefined();
    expect(bundle.modes.z1).toBeDefined();
  });
});

describe("errorForMode", () => {
  test("ignores the other numerator when the displayed mode is healthy", () => {
    const errors = [
      "NCBEILQ027S: Unsupported FRED series",
      "GDP: delayed refresh",
    ];
    expect(errorForMode(errors, "wilshire")).toBe("GDP: delayed refresh");
    expect(errorForMode(errors, "z1")).toBe("NCBEILQ027S: Unsupported FRED series");
  });

  test("returns null when only the inactive mode failed", () => {
    expect(errorForMode(["NCBEILQ027S: offline"], "wilshire")).toBeNull();
  });
});
