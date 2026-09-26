import { afterEach, expect, spyOn, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createSeriesCache, type DatedObservation } from "./series-cache";

const observations = [{ date: "2026-01-01", value: 100 }];
let clock: ReturnType<typeof spyOn> | undefined;
afterEach(() => clock?.mockRestore());

test("array hydration remains available without inventing retrieval metadata or requesting data", async () => {
  const cache = createSeriesCache("test", 60_000);
  cache.hydrate([["key", observations], ["empty", []]]);
  const loader = async () => { throw new Error("no cloud in snapshot renderer"); };
  expect(await cache.load("key", loader)).toBe(observations);
  expect(await cache.load("empty", loader)).toEqual([]);
  expect(await cache.loadEntry("key", loader, { force: true })).toEqual({ observations, fetchedAt: null, stale: null, source: "hydrated" });
  cache.reset();
  await expect(cache.load("key", loader)).rejects.toThrow("no cloud");
});

test("metadata loads join existing requests and preserve array cache reads", async () => {
  const cache = createSeriesCache("test", 60_000);
  const store = new MemoryPluginPersistence();
  cache.attach(store);
  const request = Promise.withResolvers<DatedObservation[]>();
  let calls = 0;
  const first = cache.load("key", () => { calls++; return request.promise; });
  const joined = cache.loadEntry("key", async () => { calls++; return []; }, { force: true });
  request.resolve(observations);
  expect(await first).toEqual(observations);
  expect((await joined).observations).toEqual(observations);
  expect(calls).toBe(1);
  expect(await cache.load("key", async () => { throw new Error("fresh"); })).toEqual(observations);
  expect(cache.get("key")?.stale).toBe(false);
});

test("successful retrieval in the same millisecond clears retained refresh failure", async () => {
  clock = spyOn(Date, "now").mockReturnValue(1_000_000);
  const cache = createSeriesCache("test", 60_000);
  await cache.load("key", async () => observations);
  const failure = await cache.loadEntry("key", async () => { throw new Error("outage"); }, { force: true });
  expect(failure).toMatchObject({ fetchedAt: 1_000_000, stale: true, refreshError: "outage" });
  expect(cache.get("key")).toMatchObject({ stale: true, refreshError: "outage" });
  await cache.loadEntry("key", async () => observations, { force: true });
  expect(cache.get("key")).toMatchObject({ fetchedAt: 1_000_000, stale: false });
  expect(cache.get("key")?.refreshError).toBeUndefined();
});

test("old failed requests cannot carry metadata across reset and attachment", async () => {
  clock = spyOn(Date, "now").mockReturnValue(1_000_000);
  const cache = createSeriesCache("test", 60_000);
  cache.attach(new MemoryPluginPersistence());
  await cache.load("key", async () => observations);
  const delayed = Promise.withResolvers<DatedObservation[]>();
  const old = cache.loadEntry("key", () => delayed.promise, { force: true });
  cache.reset();
  cache.attach(new MemoryPluginPersistence());
  await cache.load("key", async () => observations);
  delayed.reject(new Error("old owner"));
  await old;
  expect(cache.get("key")).toMatchObject({ stale: false });
  expect(cache.get("key")?.refreshError).toBeUndefined();
});

test("failure status survives distinct retrieval and persistence timestamps without another request", async () => {
  let time = 1_000_000;
  clock = spyOn(Date, "now").mockImplementation(() => time++);
  const cache = createSeriesCache("test", 60_000);
  cache.attach(new MemoryPluginPersistence());
  const initial = await cache.loadEntry("key", async () => observations);
  expect(cache.get("key")?.fetchedAt).not.toBe(initial.fetchedAt);
  await cache.loadEntry("key", async () => { throw new Error("outage"); }, { force: true });
  const cached = await cache.loadEntry("key", async () => { throw new Error("must not request"); });
  expect(cached).toMatchObject({ fetchedAt: initial.fetchedAt, stale: true, refreshError: "outage" });
  expect(cache.get("key")).toMatchObject({ stale: true, refreshError: "outage" });
});


test("provider provenance survives restart and failed refresh alongside legacy array entries", async () => {
  clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-14T12:00:00Z"));
  const cache = createSeriesCache("provider-test", 60_000);
  const store = new MemoryPluginPersistence();
  cache.attach(store);
  const provider = { fetchedAt: "2026-09-10T12:00:00Z", stale: true };
  await cache.loadEntry("rich", async () => ({ observations, provider }));
  await cache.load("legacy", async () => observations);
  cache.reset();
  cache.attach(store);
  const unexpected = async () => { throw new Error("no request for fresh local cache"); };
  const cached = await cache.loadEntry("rich", unexpected);
  expect(cached).toMatchObject({ observations, provider, fetchedAt: Date.now(), stale: false });
  expect(cache.get("rich")?.provider).toEqual(provider);
  expect(await cache.load("legacy", unexpected)).toEqual(observations);
  expect(cache.get("legacy")?.provider).toBeUndefined();
  const failed = await cache.loadEntry("rich", async () => { throw new Error("source outage"); }, { force: true });
  expect(failed).toMatchObject({ provider, stale: true, fetchedAt: cached.fetchedAt, refreshError: "source outage" });
  const freshProvider = { fetchedAt: "2026-09-14T12:00:00Z", stale: false };
  await cache.loadEntry("rich", async () => ({ observations, provider: freshProvider }), { force: true });
  expect(cache.get("rich")).toMatchObject({ provider: freshProvider, stale: false });
});
