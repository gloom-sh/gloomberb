import { afterEach, expect, spyOn, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { statsCache } from "./cache";
import { createStatSeriesLoader, getCachedStatsBundle, loadStatsBundle } from "./client";
import { projectStatsHeadlessBundle } from "./headless";
import { resolveStatArg } from "./stats";

const cpi = resolveStatArg("cpi-yoy")!;
const unemployment = resolveStatArg("unemployment")!;
const now = Date.parse("2026-02-20T12:00:00Z");
let clock: ReturnType<typeof spyOn> | undefined;
afterEach(() => { clock?.mockRestore(); statsCache.reset(); });

function observations(revised = false) {
  return Array.from({ length: 26 }, (_, index) => ({
    date: new Date(Date.UTC(2023, 11 + index, 1)).toISOString().slice(0, 10),
    value: index === 25 ? 110 : revised && index === 13 ? 105 : 100,
  }));
}

function rows(bundle: Awaited<ReturnType<typeof loadStatsBundle>>) {
  return projectStatsHeadlessBundle(bundle, "ALL", cpi.id).sections.flatMap((section) => section.rows ?? []);
}

test("explicit refresh retrieves a same-period revision while normal loads retain source time", async () => {
  let time = now;
  clock = spyOn(Date, "now").mockImplementation(() => time);
  statsCache.attach(new MemoryPluginPersistence());
  let revised = false;
  let calls = 0;
  const loader = createStatSeriesLoader({ getCloudFredSeries: async (seriesId) => {
    calls += 1;
    return { seriesId, observations: observations(revised) };
  } });
  const initial = await loadStatsBundle({ loader, stats: [cpi] });
  expect(rows(initial)[0]).toMatchObject({ latest: 10.000000000000009, asOf: "2026-01-01", fetchedAt: now, stale: false });
  revised = true;
  time += 60_000;
  const cached = await loadStatsBundle({ loader, stats: [cpi] });
  expect(calls).toBe(1);
  expect(cached.fetchedAt).toBe(now);
  expect(getCachedStatsBundle([cpi])?.fetchedAt).toBe(now);
  const refreshed = await loadStatsBundle({ loader, stats: [cpi], force: true });
  expect(calls).toBe(2);
  expect(rows(refreshed)[0]!.latest).toBeCloseTo(4.7619047619);
  expect(rows(refreshed)[0]).toMatchObject({ asOf: "2026-01-01", fetchedAt: time, stale: false });
  expect(refreshed.fetchedAtComplete).toBe(true);
  expect(getCachedStatsBundle([cpi])?.fetchedAt).toBe(time);
});

test("failed forced refresh keeps cached CPI, independently updates unemployment, and remains stale until recovery", async () => {
  let time = now;
  clock = spyOn(Date, "now").mockImplementation(() => time);
  statsCache.attach(new MemoryPluginPersistence());
  let fail = false;
  let calls = 0;
  const loader = createStatSeriesLoader({ getCloudFredSeries: async (seriesId) => {
    calls += 1;
    if (seriesId === cpi.seriesId && fail) throw new Error("Controlled CPI failure");
    return { seriesId, observations: observations(true).map((entry) => ({
      ...entry, value: seriesId === cpi.seriesId ? entry.value : fail ? 4.6 : 4.2,
    })) };
  } });
  await loadStatsBundle({ loader, stats: [cpi, unemployment] });
  time += 60_000;
  fail = true;
  const failed = await loadStatsBundle({ loader, stats: [cpi, unemployment], force: true });
  expect(failed.errors).toEqual(["CPIAUCNS: Controlled CPI failure"]);
  expect(failed.fetchedAt).toBe(now);
  expect(failed.fetchedAtComplete).toBe(true);
  expect(rows(failed).find((row) => row.id === cpi.id)).toMatchObject({ fetchedAt: now, stale: true, cacheSource: "stale-fallback", refreshError: "Controlled CPI failure" });
  expect(rows(failed).find((row) => row.id === unemployment.id)).toMatchObject({ latest: 4.6, fetchedAt: time, stale: false });
  const cached = await loadStatsBundle({ loader, stats: [cpi, unemployment] });
  expect(calls).toBe(4);
  expect(cached.errors).toEqual(failed.errors);
  expect(getCachedStatsBundle([cpi, unemployment])?.errors).toEqual(failed.errors);
  expect(rows(cached).find((row) => row.id === cpi.id)?.stale).toBe(true);
  fail = false;
  const recovered = await loadStatsBundle({ loader, stats: [cpi, unemployment], force: true });
  expect(recovered.errors).toEqual([]);
  expect(rows(recovered).every((row) => row.stale === false)).toBe(true);
});

test("a cold failed series does not remove an independent series", async () => {
  const bundle = await loadStatsBundle({ stats: [cpi, unemployment], loader: async (def) => {
    if (def === cpi) throw new Error("Controlled cold failure");
    return observations().map((entry) => ({ ...entry, value: 4.6 }));
  } });
  expect(bundle.builds.map(({ stat }) => stat.id)).toEqual([unemployment.id]);
  expect(bundle.errors).toEqual(["CPIAUCNS: Controlled cold failure"]);
  expect(bundle.fetchedAt).toBeNull();
  expect(bundle.fetchedAtComplete).toBe(false);
});

test("mixed known and unprovenanced observations retain explicit partial retrieval coverage", async () => {
  clock = spyOn(Date, "now").mockReturnValue(now);
  const bundle = await loadStatsBundle({ stats: [cpi, unemployment], loader: async (def) => def === cpi
    ? { observations: observations(), fetchedAt: now - 1000, stale: false, source: "cache" }
    : observations().map((entry) => ({ ...entry, value: 4.2 })) });
  const report = projectStatsHeadlessBundle(bundle, "ALL", cpi.id);
  expect(report.metadata).toMatchObject({ fetchedAt: now - 1000, fetchedAtComplete: false });
  expect(rows(bundle).find((row) => row.id === unemployment.id)).toMatchObject({ fetchedAt: null, cacheStale: null, stale: null });
  statsCache.hydrate([[cpi.seriesId, observations()]]);
  const hydrated = await loadStatsBundle({ stats: [cpi] });
  expect(hydrated.fetchedAt).toBeNull();
  expect(hydrated.fetchedAtComplete).toBe(false);
  expect(rows(hydrated)[0]).toMatchObject({ fetchedAt: null, cacheStale: null, stale: null, cacheSource: "hydrated" });
});

test("2s10s never runs ahead of the 2Y and 10Y rows it is computed from", async () => {
  const days = (last: string, value: number) => ["2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22"]
    .filter((date) => date <= last).map((date) => ({ date, value }));
  const series: Record<string, Array<{ date: string; value: number }>> = {
    DGS10: days("2026-09-21", 4.96), DGS2: days("2026-09-21", 4.76), T10Y2Y: days("2026-09-22", 0.25),
  };
  const stats = [resolveStatArg("ten-year")!, resolveStatArg("two-year")!, resolveStatArg("curve-spread")!];
  const bundle = await loadStatsBundle({ loader: async (def) => series[def.seriesId]!, stats });
  expect(bundle.builds.map((build) => build.points.at(-1)?.date)).toEqual(["2026-09-21", "2026-09-21", "2026-09-21"]);
  // Alone, the spread keeps its newest print.
  const alone = await loadStatsBundle({ loader: async (def) => series[def.seriesId]!, stats: [resolveStatArg("curve-spread")!] });
  expect(alone.builds[0]!.points.at(-1)?.date).toBe("2026-09-22");
});
