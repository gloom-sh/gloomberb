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
  test("refreshes legacy metadata and preserves coverage and source freshness through reopening", async () => {
    const persistence = new MemoryPluginPersistence();
    const request: FredSeriesRequest = { seriesId: "BAMLC0A0CM", startDate: "2007-01-01", sortOrder: "asc" };
    const old = { ...makeSeries(0.8), info: { ...makeSeries(0.8).info!, id: request.seriesId } };
    persistence.seedResource("fred-series", "BAMLC0A0CM:start=2007-01-01:sort=asc", old,
      { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachFredSeriesPersistence(persistence);
    let calls = 0;
    const fetchedAt = new Date(Date.now() - 60_000).toISOString();
    const updated = { ...old, fetchedAt, info: { ...old.info, observationStart: "2023-09-12", observationEnd: "2026-09-10" } };
    const loaded = await loadCachedFredSeries(request, async () => { calls++; return updated; });
    expect(calls).toBe(1);
    expect(loaded.data.info?.observationStart).toBe("2023-09-12");
    resetFredSeriesPersistence();
    attachFredSeriesPersistence(persistence);
    const reopened = await loadCachedFredSeries(request, async () => { throw Error("Must reuse upgraded cache"); });
    expect(reopened.data).toEqual(updated);
    expect(reopened.fetchedAt).toBe(Date.parse(fetchedAt));
    expect(reopened.stale).toBe(false);
    const offline = await loadCachedFredSeries(request, async () => { throw Error("offline"); }, { force: true });
    expect(offline.stale).toBe(true);
    expect(offline.data.info?.observationEnd).toBe("2026-09-10");
    expect(offline.fetchedAt).toBe(Date.parse(fetchedAt));
  });

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
        schemaVersion: 2,
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

test("a successful HTTP response cannot erase the source's stale flag or retrieval time", async () => {
  const { withFredSourceFreshness } = await import("../../../data/fred-series");
  const sourceTime = Date.parse("2026-09-08T12:00:00Z");
  const entry = withFredSourceFreshness({
    data: { observations: [{ date: "2026-09-04", value: 4.78 }], info: null, stale: true, fetchedAt: new Date(sourceTime).toISOString() },
    fetchedAt: Date.parse("2026-09-10T12:00:00Z"),
    stale: false,
    source: "network" as const,
  });
  expect(entry.stale).toBe(true);
  expect(entry.fetchedAt).toBe(sourceTime);
});
