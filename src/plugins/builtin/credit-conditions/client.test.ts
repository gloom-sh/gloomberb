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
      date: new Date(Date.UTC(2026, 6, 1) + index * 86_400_000).toISOString().slice(0, 10),
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

  test("rejects another index before storing it under the requested FRED series", async () => {
    const persistence = new MemoryPluginPersistence();
    attachFredSeriesPersistence(persistence);
    const aaa = CREDIT_SERIES[1].seriesId;
    const result = await loadCreditConditions(false, async (seriesId) =>
      payload(seriesId === aaa ? CREDIT_SERIES[5].seriesId : seriesId));
    expect(result.rows.some((row) => row.seriesId === aaa)).toBe(false);
    expect(result.errors).toEqual([`${aaa}: unexpected FRED metadata`]);
    expect(persistence.getResource("fred-series", `${aaa}:limit=300:sort=desc`,
      { sourceKey: "gloomberb-cloud", schemaVersion: 2 })).toBeNull();
  });

  test("invalid metadata refresh retains the dated prior row and cache until valid recovery", async () => {
    const persistence = new MemoryPluginPersistence();
    attachFredSeriesPersistence(persistence);
    const aaa = CREDIT_SERIES[1].seriesId;
    const readCached = () => persistence.getResource<ReturnType<typeof payload>>(
      "fred-series", `${aaa}:limit=300:sort=desc`, { sourceKey: "gloomberb-cloud", schemaVersion: 2 });
    await loadCreditConditions(false, async (seriesId) => payload(seriesId));
    const before = readCached();
    for (const change of ["units", "identity"] as const) {
      const failed = await loadCreditConditions(true, async (seriesId) => {
        const data = payload(seriesId);
        if (seriesId === aaa) {
          if (change === "units") data.info.units = "Index";
          else data.info.id = CREDIT_SERIES[5].seriesId;
        }
        return data;
      });
      expect(failed.rows.find((row) => row.seriesId === aaa))
        .toMatchObject({ oasBp: 82, date: "2026-07-03", stale: true });
      expect(failed.errors.join(" ")).toContain("unexpected FRED metadata");
      expect(readCached()).toEqual(before);
    }
    const recovered = await loadCreditConditions(true, async (seriesId) => ({
      ...payload(seriesId), observations: [{ date: "2026-07-06", value: 0 }],
    }));
    expect(recovered.rows.find((row) => row.seriesId === aaa))
      .toMatchObject({ oasBp: 0, date: "2026-07-06", stale: false });
    expect(recovered.errors).toEqual([]);
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
        return payload(seriesId, 320);
      });
      expect(persistence.getResource<{ observations: unknown[] }>(
        "fred-series",
        `${CREDIT_SERIES[0].seriesId}:limit=300:sort=desc`,
        { sourceKey: "gloomberb-cloud", schemaVersion: 2 },
      )?.value.observations).toHaveLength(300);

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
