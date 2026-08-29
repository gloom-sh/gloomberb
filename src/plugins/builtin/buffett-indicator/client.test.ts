import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../../../data/fred-series";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { loadBuffettBundle } from "./client";
import type { BuffettSeriesLoader } from "./model";

function payload(seriesId: string, observations: Array<{ date: string; value: number }>) {
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
    const requests: Array<{ seriesId: string; limit?: number; sortOrder?: string; startDate?: string }> = [];
    const loader: BuffettSeriesLoader = async (request) => {
      requests.push({
        seriesId: request.seriesId,
        limit: request.limit,
        sortOrder: request.sortOrder,
        startDate: request.startDate,
      });
      if (request.seriesId === "WILL5000PRFC") return payload(request.seriesId, wilshireObs);
      if (request.seriesId === "NCBEILQ027S") return payload(request.seriesId, z1Obs);
      if (request.seriesId === "GDP") return payload(request.seriesId, gdpObs);
      throw new Error(`unexpected ${request.seriesId}`);
    };

    const bundle = await loadBuffettBundle({ force: true, loader });
    expect(Object.keys(bundle.modes).sort()).toEqual(["wilshire", "z1"]);
    expect(requests.map((r) => r.seriesId).sort()).toEqual([
      "GDP",
      "NCBEILQ027S",
      "WILL5000PRFC",
    ]);
    for (const request of requests) {
      expect(request.startDate).toBeUndefined();
      expect(request.sortOrder).toBe("desc");
      if (request.seriesId === "WILL5000PRFC") expect(request.limit).toBe(4000);
      else expect(request.limit).toBe(340);
    }
  });

  test("degrades to one mode when a numerator fails", async () => {
    const loader: BuffettSeriesLoader = async (request) => {
      if (request.seriesId === "WILL5000PRFC" || request.seriesId === "WILL5000PR") {
        throw new Error("Unsupported FRED series");
      }
      if (request.seriesId === "NCBEILQ027S") return payload(request.seriesId, z1Obs);
      if (request.seriesId === "GDP") return payload(request.seriesId, gdpObs);
      throw new Error(`unexpected ${request.seriesId}`);
    };
    const bundle = await loadBuffettBundle({ force: true, loader });
    expect(bundle.modes.z1).toBeDefined();
    expect(bundle.modes.wilshire).toBeUndefined();
  });

  test("retries Wilshire fallback after primary failure", async () => {
    const seen: string[] = [];
    const loader: BuffettSeriesLoader = async (request) => {
      seen.push(request.seriesId);
      if (request.seriesId === "WILL5000PRFC") throw new Error("Unsupported FRED series");
      if (request.seriesId === "WILL5000PR") return payload(request.seriesId, wilshireObs);
      if (request.seriesId === "NCBEILQ027S") throw new Error("Unsupported FRED series");
      if (request.seriesId === "GDP") return payload(request.seriesId, gdpObs);
      throw new Error(`unexpected ${request.seriesId}`);
    };
    const bundle = await loadBuffettBundle({ force: true, loader });
    expect(seen).toContain("WILL5000PR");
    expect(bundle.modes.wilshire?.series.resolvedNumeratorId).toBe("WILL5000PR");
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
      "WILL5000PRFC:limit=4000:sort=desc",
      payload("WILL5000PRFC", wilshireObs),
      { sourceKey: "gloomberb-cloud", schemaVersion: 1 },
    );
    persistence.seedResource(
      "fred-series",
      "NCBEILQ027S:limit=340:sort=desc",
      payload("NCBEILQ027S", z1Obs),
      { sourceKey: "gloomberb-cloud", schemaVersion: 1 },
    );
    persistence.seedResource(
      "fred-series",
      "GDP:limit=340:sort=desc",
      payload("GDP", gdpObs),
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
