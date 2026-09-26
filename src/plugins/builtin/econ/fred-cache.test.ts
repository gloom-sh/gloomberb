import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import {
  attachFredSeriesPersistence,
  isFredPublicationPending,
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

test("a daily series cached before its morning publication is re-read within the day", async () => {
  const request: FredSeriesRequest = { seriesId: "VIXCLS", limit: 400, sortOrder: "desc" };
  const series = (...dates: string[]): FredSeriesData => ({
    observations: dates.map((date) => ({ date, value: 14.2 })), info: null,
  });
  const beforeRelease = series("2026-09-21", "2026-09-18", "2026-09-17", "2026-09-16");
  const published = series("2026-09-22", ...beforeRelease.observations.map((point) => point.date));
  const persistence = new MemoryPluginPersistence();
  attachFredSeriesPersistence(persistence);
  try {
    // 06:00 New York on Wednesday 2026-09-23, before FRED posts the 09-22 close.
    setSystemTime(new Date("2026-09-23T10:00:00Z"));
    await loadCachedFredSeries(request, async () => beforeRelease);
    let calls = 0;
    const loader = async () => { calls++; return published; };
    setSystemTime(new Date("2026-09-23T10:20:00Z"));
    expect((await loadCachedFredSeries(request, loader)).data).toEqual(beforeRelease);
    expect(calls).toBe(0);
    setSystemTime(new Date("2026-09-23T10:45:00Z"));
    expect((await loadCachedFredSeries(request, async () => { throw Error("offline"); })).stale).toBe(false);
    const refreshed = await loadCachedFredSeries(request, loader);
    expect(calls).toBe(1);
    expect(refreshed.data.observations[0]!.date).toBe("2026-09-22");
    setSystemTime(new Date("2026-09-23T20:00:00Z"));
    await loadCachedFredSeries(request, loader);
    expect(calls).toBe(1);
  } finally {
    setSystemTime();
  }
  const hour = 60 * 60_000;
  // Weekends publish nothing; weekly series keep the nominal policy.
  const saturday = Date.parse("2026-09-26T15:00:00Z");
  expect(isFredPublicationPending(series("2026-09-24", "2026-09-23", "2026-09-22").observations, saturday - 2 * hour, saturday)).toBe(false);
  const monday = Date.parse("2026-09-28T15:00:00Z");
  expect(isFredPublicationPending(series("2026-09-24", "2026-09-23", "2026-09-22").observations, monday - hour, monday)).toBe(true);
  expect(isFredPublicationPending(series("2026-09-16", "2026-09-09", "2026-09-02").observations, monday - hour, monday)).toBe(false);
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
