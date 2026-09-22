import { afterEach, expect, setSystemTime, test } from "bun:test";
import { MarketDataCoordinator } from "./index";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { PriceHistoryResult, HistorySession } from "../../types/price-history";
import type { ChartRequest } from "../request-types";

const coordinators: MarketDataCoordinator[] = [];
afterEach(() => { coordinators.splice(0).forEach(coordinator => coordinator.destroy()); setSystemTime(); });
const at = (time: string) => Date.parse(time);
const preopen = at("2026-09-22T12:42:12Z");
const request: ChartRequest = { instrument: { symbol: "AAPL", exchange: "NASDAQ" }, bufferRange: "1M",
  granularity: "resolution", resolution: "15m" };
const sourceKey = "provider:gloomberb-cloud";
const proof = (patch: Partial<HistorySession> = {}): HistorySession => ({ version: 1, kind: "regular", calendar: "us-equity",
  timeZone: "America/New_York", symbol: "AAPL", exchange: "NASDAQ", interval: "15min", source: "yahoo",
  timestampConvention: "bar-open", barAlignment: "session-open", observedAt: Date.now(), ...patch });
function result(time = "2026-09-21T19:45:00Z", patch: Partial<PriceHistoryResult> = {}): PriceHistoryResult {
  return { points: [{ date: new Date(time), close: 338.8900146484375, volume: 2218511 }],
    resolution: "15m", session: proof(), sourceKey, ...patch };
}
function coordinator(load: (...args: any[]) => Promise<PriceHistoryResult>) {
  const instance = new MarketDataCoordinator(createTestDataProvider({ id: "preferred-router",
    getPriceHistoryForResolutionWithMetadata: load,
    getPriceHistory: async () => { throw new Error("Unexpected legacy/default history traversal"); } }));
  coordinators.push(instance);
  return instance;
}

test("coordinator retains actual source/session/cadence and does not renew cache age during normalization", async () => {
  setSystemTime(preopen);
  let calls = 0;
  const instance = coordinator(async () => { calls++; return result(); });
  const first = await instance.loadChart(request);
  expect(first.data?.[0]?.close).toBe(338.8900146484375);
  expect(first.history).toMatchObject({ resolution: "15m", sourceKey, session: { observedAt: preopen, source: "yahoo" } });
  expect(first.source).toBe(sourceKey);
  setSystemTime(preopen + 9 * 60_000);
  const cached = await instance.loadChart(request);
  expect(calls).toBe(1);
  expect(cached.fetchedAt).toBe(first.fetchedAt);
  expect(cached.history).toEqual(first.history);
  setSystemTime(preopen + 11 * 60_000);
  await instance.loadChart(request);
  expect(calls).toBe(2);
});

test("the first due completed bar invalidates cached prior-session history inside its ten-minute TTL", async () => {
  const beforeDue = at("2026-09-22T13:44:00Z");
  setSystemTime(beforeDue);
  let calls = 0;
  const instance = coordinator(async () => result(++calls === 1 ? "2026-09-21T19:59:00Z" : "2026-09-22T13:45:00Z",
    { resolution: "1m", session: proof({ interval: "1min" }) }));
  const minuteRequest = { ...request, resolution: "1m" as const };
  expect((await instance.loadChart(minuteRequest)).data).toHaveLength(1);
  setSystemTime(at("2026-09-22T13:46:00Z"));
  const refreshed = await instance.loadChart(minuteRequest);
  expect(calls).toBe(2);
  expect(refreshed.data?.[0]?.date.toISOString()).toBe("2026-09-22T13:45:00.000Z");
});

test("a stale intraday bar invalidates coordinator cache before TTL without borrowing quote freshness", async () => {
  setSystemTime(at("2026-09-22T14:01:00Z"));
  let calls = 0;
  const instance = coordinator(async () => result(++calls === 1 ? "2026-09-22T13:32:00Z" : "2026-09-22T14:02:00Z",
    { resolution: "1m", session: proof({ interval: "1min" }) }));
  const minuteRequest = { ...request, resolution: "1m" as const };
  await instance.loadChart(minuteRequest);
  setSystemTime(at("2026-09-22T14:03:00Z"));
  expect((await instance.loadChart(minuteRequest)).data?.[0]?.date.toISOString()).toBe("2026-09-22T14:02:00.000Z");
  expect(calls).toBe(2);
});

test("empty and failed refreshes preserve retained history's own source, acquisition time and cache age", async () => {
  setSystemTime(preopen);
  let calls = 0;
  const instance = coordinator(async () => {
    if (++calls === 1) return result();
    if (calls === 2) return result(undefined, { points: [], sourceKey: "provider:other", session: proof({ source: "twelvedata" }) });
    throw new Error("Controlled provider outage");
  });
  const first = await instance.loadChart(request);
  setSystemTime(preopen + 60_000);
  const empty = await instance.loadChart(request, { forceRefresh: true });
  expect(empty.data).toBeNull();
  expect(empty.lastGoodData).toEqual(first.data);
  expect(empty.history).toEqual(first.history);
  expect(empty.source).toBe(first.source);
  expect(empty.fetchedAt).toBe(first.fetchedAt);
  setSystemTime(preopen + 120_000);
  const failed = await instance.loadChart(request, { forceRefresh: true });
  expect(failed.lastGoodData).toEqual(first.data);
  expect(failed.history).toEqual(first.history);
  expect(failed.source).toBe(first.source);
  expect(failed.fetchedAt).toBe(first.fetchedAt);
  expect(failed.error?.message).toContain("outage");
});

test("pending failures cannot retain a loading seed after its next session becomes due", async () => {
  setSystemTime(at("2026-09-22T13:44:00Z"));
  let reject: (error: Error) => void = () => {};
  let calls = 0;
  const instance = coordinator(async () => ++calls === 1
    ? result("2026-09-21T19:59:00Z", { resolution: "1m", session: proof({ interval: "1min" }) })
    : new Promise<PriceHistoryResult>((_resolve, fail) => { reject = fail; }));
  const narrow = { ...request, bufferRange: "1W" as const, resolution: "1m" as const };
  const wider = { ...request, resolution: "1m" as const };
  const first = await instance.loadChart(narrow);
  const pending = instance.loadChart(wider);
  const loading = instance.getChartEntry(wider);
  expect(loading.data).toEqual(first.data);
  expect(loading.history).toEqual(first.history);
  expect(loading.fetchedAt).toBe(first.fetchedAt);
  setSystemTime(at("2026-09-22T13:46:00Z"));
  reject(new Error("Controlled provider outage"));
  const failed = await pending;
  expect(failed.lastGoodData).toBeNull();
  expect(failed.data).toBeNull();
  expect(failed.history).toBeUndefined();
});

test("source contracts never cross instrument scope and unknown sources keep conservative freshness", async () => {
  setSystemTime(preopen);
  const unproven = coordinator(async () => result(undefined, { session: undefined, sourceKey: "provider:extended" }));
  expect((await unproven.loadChart(request)).data).toBeNull();
  const mismatch = coordinator(async () => result(undefined, { session: proof({ symbol: "MSFT" }) }));
  expect((await mismatch.loadChart(request)).data).toBeNull();
  let release: (value: PriceHistoryResult) => void = () => {};
  let calls = 0;
  const instance = coordinator(async () => ++calls === 1 ? result() : new Promise(resolve => { release = resolve; }));
  await instance.loadChart({ ...request, bufferRange: "1W" });
  const other = { ...request, instrument: { ...request.instrument, brokerId: "ibkr", brokerInstanceId: "work" } };
  const pending = instance.loadChart(other);
  expect(instance.getChartEntry(other).data).toBeNull();
  release(result());
  await pending;
});

test("historical detail and source-declared daily periods keep their original cadence rules", async () => {
  setSystemTime(preopen);
  const historical = new MarketDataCoordinator(createTestDataProvider({
    getDetailedPriceHistoryWithMetadata: async () => result("2026-09-11T13:30:00Z", { session: undefined }),
    getPriceHistoryWithMetadata: async () => result("2024-01-01T00:00:00Z", { session: undefined, resolution: "1d" }),
  }));
  coordinators.push(historical);
  const detailed = await historical.loadChart({ ...request, granularity: "detail", startDate: new Date("2026-09-10T00:00:00Z"),
    endDate: new Date("2026-09-12T00:00:00Z"), barSize: "15m" });
  expect(detailed.data).toHaveLength(1);
  expect(detailed.history?.resolution).toBe("15m");
  const daily = await historical.loadChart({ instrument: request.instrument, granularity: "range", bufferRange: "1M" });
  expect(daily.data).toHaveLength(1);
  expect(daily.history?.resolution).toBe("1d");
});
