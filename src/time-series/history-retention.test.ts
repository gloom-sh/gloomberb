import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { HistoryRetentionError, type HistoryRetention } from "../sources/history-retention";
import { AssetDataRouter } from "../sources/provider-router";
import type { PricePoint, TickerFinancials } from "../types/financials";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import { ChartResolveCache, resolveChartSpecData } from "./resolve";
import { parsedPriceHistoryKey, readParsedPriceHistory } from "./parsed-history-cache";
import type { ChartSpec } from "./types";

const DAY = 86_400_000, STEP = 900_000;
const NOW = Date.parse("2026-09-22T12:00:00Z");
afterEach(() => setSystemTime());
const proof = (symbol = "RETENTION", interval = "15min"): HistoryRetention => ({
  version: 1, source: "yahoo", symbol, exchange: "CCC", interval,
  requestedStart: NOW - 92 * DAY, requestedEnd: NOW, observedAt: NOW, availableStart: NOW - 60 * DAY,
});
const history = (start = NOW - 40 * DAY, end = NOW): PricePoint[] => Array.from(
  { length: Math.floor((end - start) / STEP) + 1 }, (_, index) => ({
    date: new Date(start + index * STEP), close: 100 + index, volume: index + 1,
  }),
);
const chart = (symbol = "RETENTION", resolution: "auto" | "15m" = "auto"): ChartSpec => ({
  version: 2, viewport: { range: "1M", resolution }, panels: [{ id: "main" }], studies: [],
  series: ["close", "volume"].map(field => ({ id: field, source: { kind: "security", instrument: { symbol, exchange: "CCC" }, fieldId: `market.${field}` },
    style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" })),
});
const sources = (provider: DataProvider, now = NOW) => ({ dataProvider: provider, now: new Date(now),
  loadFredSeries: async () => { throw Error("No FRED expected"); } });

function limited(options: { data?: PricePoint[]; symbol?: string; recoveryFails?: boolean; wrongInterval?: boolean } = {}) {
  const calls: Array<{ kind: string; start?: number; end?: number; context?: MarketDataRequestContext }> = [];
  const data = options.data ?? history();
  const provider = createTestDataProvider({ id: "gloomberb-cloud",
    getChartResolutionSupport: async () => [{ resolution: "15m", maxRange: "3M" }, { resolution: "1d", maxRange: "ALL" }],
    async getPriceHistoryForResolution(_symbol, _exchange, _range, interval) {
      calls.push({ kind: interval });
      if (interval !== "15m") return [];
      throw new HistoryRetentionError(proof(options.symbol, options.wrongInterval ? "1h" : "15min"));
    },
    async getDetailedPriceHistory(_symbol, _exchange, start, end, _interval, context) {
      calls.push({ kind: context?.historyRecovery ? "recovery" : "detailed", start: +start, end: +end, context });
      if (!context?.historyRecovery) throw new HistoryRetentionError({ ...proof(options.symbol), requestedStart: Math.floor(+start / 1000) * 1000, requestedEnd: Math.floor(+end / 1000) * 1000 });
      if (options.recoveryFails) throw Error("Still unavailable");
      return data;
    },
    async getPriceHistory() { calls.push({ kind: "default" }); return []; },
  });
  return { provider, calls, data };
}

test("price and volume share one retained acquisition across quotes and study edits without seeding the broad interval cache", async () => {
  setSystemTime(NOW);
  const { provider, calls, data } = limited(), cache = new ChartResolveCache(), spec = chart();
  const captures: TickerFinancials[] = [];
  const input = { ...sources(new AssetDataRouter(provider)), onSecurityData: (_spec: unknown, value: TickerFinancials) => captures.push(value) };
  const first = await resolveChartSpecData(spec, input, cache, { awaitResolutionSupport: true });
  expect(first.errors).toEqual([]);
  expect(first.resolution).toBe("15m");
  expect(calls.map(call => call.kind)).toEqual(["15m", "recovery"]);
  const recovery = calls[1]!;
  expect(recovery.start).toBe(proof().availableStart + STEP);
  expect(recovery.end).toBe(NOW);
  expect(captures.every(value => value.priceHistoryResolution === "15m")).toBe(true);
  expect(captures[0]!.priceHistory).toHaveLength(data.length);
  expect(readParsedPriceHistory(parsedPriceHistoryKey({ symbol: "RETENTION", exchange: "CCC" }, "3M", "15m"))).toBeUndefined();
  const studied = { ...spec, studies: [{ id: "sma", kind: "sma" as const, inputSeriesIds: ["close"], parameters: { period: 200 }, panelId: "main", axis: "left" as const }] };
  const result = await resolveChartSpecData(studied, sources(input.dataProvider, NOW + 1000), cache, { awaitResolutionSupport: true });
  expect(calls.map(call => call.kind)).toEqual(["15m", "recovery"]);
  const price = result.series.find(series => series.id === "close")!.points[0]!;
  const index = data.findIndex(point => +point.date === +price.date);
  const expected = data.slice(index - 199, index + 1).reduce((sum, point) => sum + point.close, 0) / 200;
  expect(result.series.find(series => series.id === "sma")!.points[0]!.value).toBeCloseTo(expected, 10);
  expect([...cache.priceHistoryExpiryByRequest.values()]).toEqual([NOW + 300_000]);
});

test("broad independent success wins and invalid interval metadata cannot trigger a source retry", async () => {
  setSystemTime(NOW);
  const { provider, calls } = limited();
  const independent = createTestDataProvider({ id: "independent", getPriceHistoryForResolution: async () => history() });
  const result = await resolveChartSpecData(chart(), sources(new AssetDataRouter(provider, [independent])), undefined, { awaitResolutionSupport: true });
  expect(result.errors).toEqual([]);
  expect(calls.some(call => call.kind === "recovery")).toBe(false);
  const wrong = limited({ wrongInterval: true });
  await resolveChartSpecData(chart(), sources(wrong.provider));
  expect(wrong.calls.some(call => call.kind === "recovery")).toBe(false);
});

test("manual failed recovery is settled across quote ticks and retried after its finite expiry", async () => {
  setSystemTime(NOW);
  const { provider, calls } = limited({ recoveryFails: true }), cache = new ChartResolveCache(), spec = chart("RETENTION", "15m");
  const first = await resolveChartSpecData(spec, sources(provider), cache, { awaitResolutionSupport: true });
  expect(first.errors).toHaveLength(2);
  await resolveChartSpecData(spec, sources(provider, NOW + 1000), cache, { awaitResolutionSupport: true });
  expect(calls.map(call => call.kind)).toEqual(["15m", "recovery"]);
  setSystemTime(NOW + 300_001);
  await resolveChartSpecData(spec, sources(provider, NOW + 300_001), cache, { awaitResolutionSupport: true });
  expect(calls.filter(call => call.kind === "15m")).toHaveLength(2);
  expect(calls.some(call => call.kind === "default")).toBe(false);
});

test("old manual windows do not shrink into a recent recovery or become daily data", async () => {
  setSystemTime(NOW);
  const { provider, calls } = limited(), spec = chart("RETENTION", "15m");
  spec.viewport.dateWindow = { start: "2026-07-01T00:00:00Z", end: "2026-07-10T00:00:00Z" };
  const result = await resolveChartSpecData(spec, sources(provider));
  expect(result.series.every(series => series.points.length === 0)).toBe(true);
  expect(calls.some(call => call.kind === "recovery" || call.kind === "default" || call.kind === "1d")).toBe(false);
});

test("Auto stops after the scoped recovery fails instead of replaying unqualified source chains", async () => {
  setSystemTime(NOW);
  const { provider, calls } = limited({ recoveryFails: true }), cache = new ChartResolveCache(), spec = chart();
  const result = await resolveChartSpecData(spec, sources(provider), cache, { awaitResolutionSupport: true });
  expect(result.errors).toHaveLength(2);
  await resolveChartSpecData(spec, sources(provider), cache, { awaitResolutionSupport: true });
  expect(calls.map(call => call.kind)).toEqual(["15m", "recovery"]);
});

test("explicit daily fallback retains its served cadence; opaque defaults cannot answer an authored daily source", async () => {
  setSystemTime(NOW);
  const { provider, calls } = limited({ recoveryFails: true });
  const daily = [{ date: new Date(NOW - DAY), close: 123 }, { date: new Date(NOW), close: 125 }];
  provider.getDetailedPriceHistory = undefined;
  const limitedResolution = provider.getPriceHistoryForResolution!;
  provider.getPriceHistoryForResolution = async (...args) => args[3] === "1d" ? daily : limitedResolution(...args);
  const captures: TickerFinancials[] = [];
  const result = await resolveChartSpecData(chart(), { ...sources(provider), onSecurityData: (_spec, data) => captures.push(data) });
  expect(result.errors).toEqual([]);
  expect(result.resolution).toBe("1d");
  expect(result.series.every(series => series.historyResolution === "1d" && series.nativeFrequency === "daily")).toBe(true);
  expect(captures.every(data => data.priceHistoryResolution === "1d")).toBe(true);
  expect(calls.some(call => call.kind === "default")).toBe(false);
  const opaque = createTestDataProvider({ getPriceHistory: async () => daily });
  const cache = new ChartResolveCache(), auto = chart("OPAQUE");
  expect((await resolveChartSpecData(auto, sources(opaque), cache)).resolution).toBeUndefined();
  auto.series.forEach(series => { if (series.source.kind === "security") series.source.period = "daily"; });
  const explicit = await resolveChartSpecData(auto, sources(opaque), cache);
  expect(explicit.errors).toHaveLength(2);
  expect(explicit.series.every(series => series.points.length === 0)).toBe(true);
});
