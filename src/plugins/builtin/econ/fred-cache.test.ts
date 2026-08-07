import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import {
  attachFredSeriesPersistence,
  hydrateFredSeries,
  loadCachedFredSeries,
  resetFredSeriesPersistence,
  type FredSeriesData,
  type FredSeriesRequest,
} from "../../../data/fred-series";

const REQUEST: FredSeriesRequest = {
  seriesId: "CPIAUCSL",
  startDate: "2021-05-24",
  sortOrder: "asc",
};

function makeSeries(value: number): FredSeriesData {
  return {
    observations: [
      { date: "2026-05-01", value },
    ],
    info: {
      id: "CPIAUCSL",
      title: "Consumer Price Index",
      units: "Index 1982-1984=100",
      frequency: "Monthly",
      seasonalAdjustment: "Seasonally Adjusted",
      source: "FRED",
      notes: "",
    },
  };
}

// Plugin activation in other test files attaches a live persistence to this
// module and never detaches it, so the cache these tests exercise depends on
// which file ran first. Establish the state instead of inheriting it.
beforeEach(() => {
  resetFredSeriesPersistence();
});

afterEach(() => {
  resetFredSeriesPersistence();
});

describe("FRED series cache", () => {
  test("uses server-hydrated series without calling the network loader", async () => {
    hydrateFredSeries([["cpiaucsl", {
      data: makeSeries(321),
      fetchedAt: 123,
      stale: false,
    }]]);
    let calls = 0;

    const result = await loadCachedFredSeries(REQUEST, async () => {
      calls += 1;
      return makeSeries(1);
    });

    expect(calls).toBe(0);
    expect(result.source).toBe("cache");
    expect(result.fetchedAt).toBe(123);
    expect(result.data.observations[0]!.value).toBe(321);
  });

  test("rehydrates persisted series without refetching", async () => {
    const persistence = new MemoryPluginPersistence();
    attachFredSeriesPersistence(persistence);

    await loadCachedFredSeries(REQUEST, async () => makeSeries(320));

    resetFredSeriesPersistence();
    attachFredSeriesPersistence(persistence);

    let calls = 0;
    const cached = await loadCachedFredSeries(REQUEST, async () => {
      calls += 1;
      return makeSeries(1);
    });

    expect(calls).toBe(0);
    expect(cached.source).toBe("cache");
    expect(cached.stale).toBe(false);
    expect(cached.data.observations[0]!.value).toBe(320);
    expect(cached.data.info?.id).toBe("CPIAUCSL");
  });

  test("reports stale cached data when a refresh fails", async () => {
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource(
      "fred-series",
      "CPIAUCSL:start=2021-05-24:sort=asc",
      makeSeries(319),
      {
        sourceKey: "gloomberb-cloud",
        schemaVersion: 1,
        stale: true,
      },
    );
    attachFredSeriesPersistence(persistence);

    const result = await loadCachedFredSeries(REQUEST, async () => {
      throw new Error("network unavailable");
    });

    expect(result.source).toBe("stale-fallback");
    expect(result.stale).toBe(true);
    expect(result.refreshError).toBe("network unavailable");
    expect(result.data.observations[0]!.value).toBe(319);
  });
});
