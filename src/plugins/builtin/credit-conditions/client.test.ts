import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../../../data/fred-series";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { loadCreditConditions } from "./client";
import { CREDIT_SERIES, type CreditSeriesId } from "./model";

function payload(seriesId: CreditSeriesId, count = 3) {
  return {
    observations: Array.from({ length: count }, (_, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, "0")}`,
      value: 0.8 + index / 100,
    })),
    info: {
      id: seriesId,
      title: `${seriesId} Option-Adjusted Spread`,
      units: "Percent",
      frequency: "Daily, Close",
      seasonalAdjustment: "Not Seasonally Adjusted",
      source: "FRED",
      notes: "",
    },
  };
}

beforeEach(resetFredSeriesPersistence);
afterEach(resetFredSeriesPersistence);

describe("loadCreditConditions", () => {
  test("returns available rows and reports partial failures", async () => {
    const result = await loadCreditConditions(false, async (seriesId) => {
      if (seriesId !== CREDIT_SERIES[0].seriesId) throw new Error("unavailable");
      return payload(seriesId);
    });

    expect(result.rows.map((row) => row.seriesId)).toEqual([CREDIT_SERIES[0].seriesId]);
    expect(result.errors).toHaveLength(CREDIT_SERIES.length - 1);
  });

  test("throws when every credit series fails", async () => {
    await expect(loadCreditConditions(false, async () => {
      throw new Error("offline");
    })).rejects.toThrow("offline");
  });

  test("reuses bounded persisted history across midnight", async () => {
    const persistence = new MemoryPluginPersistence();
    attachFredSeriesPersistence(persistence);
    const originalNow = Date.now;
    let calls = 0;

    try {
      Date.now = () => Date.UTC(2026, 7, 18, 23, 58);
      await loadCreditConditions(false, async (seriesId) => {
        calls += 1;
        return payload(seriesId, 60);
      });
      expect(persistence.getResource<{ observations: unknown[] }>(
        "fred-series",
        `${CREDIT_SERIES[0].seriesId}:limit=45:sort=desc`,
        { sourceKey: "gloomberb-cloud", schemaVersion: 1 },
      )?.value.observations).toHaveLength(45);

      resetFredSeriesPersistence();
      attachFredSeriesPersistence(persistence);
      Date.now = () => Date.UTC(2026, 7, 19, 0, 2);
      const cached = await loadCreditConditions(false, async () => {
        calls += 1;
        throw new Error("cache miss");
      });

      expect(calls).toBe(CREDIT_SERIES.length);
      expect(cached.rows).toHaveLength(CREDIT_SERIES.length);
    } finally {
      Date.now = originalNow;
    }
  });
});
