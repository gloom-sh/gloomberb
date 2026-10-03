import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { HistoryRetentionError, historyRetentionNotice, type HistoryRetention } from "../sources/history-retention";
import { AssetDataRouter } from "../sources/provider-router";
import type { PricePoint, TickerFinancials } from "../types/financials";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import { ChartResolveCache, resolveChartSpecData } from "./resolve";
import { parsedPriceHistoryKey, readParsedHistoryResult } from "./parsed-history-cache";
import { subtractTimeRange } from "./date-window";
import type { TimeRange } from "./range";
import type { ChartSpec } from "./types";

const DAY = 86_400_000, STEP = 900_000;
const NOW = Date.parse("2026-09-22T12:00:00Z");
afterEach(() => setSystemTime());
const proof = (symbol = "RETENTION", interval = "15min"): HistoryRetention => ({
  version: 1, source: "gloom", symbol, exchange: "CCC", interval,
  requestedStart: NOW - 92 * DAY, requestedEnd: NOW, observedAt: NOW, availableStart: NOW - 60 * DAY,
});
const history = (start = NOW - 40 * DAY, end = NOW): PricePoint[] => Array.from(
  { length: Math.floor((end - start) / STEP) + 1 }, (_, index) => ({
    date: new Date(start + index * STEP), close: 100 + index, volume: index + 1,
  }),
);
const chart = (symbol = "RETENTION", resolution: "auto" | "15m" = "auto", range: TimeRange = "1M", exchange = "CCC"): ChartSpec => ({
  version: 2, viewport: { range, resolution }, panels: [{ id: "main" }], studies: [],
  series: ["close", "volume"].map(field => ({ id: field, source: { kind: "security", instrument: { symbol, exchange }, fieldId: `market.${field}` },
    style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" })),
});
const retentionNotices = (warnings: readonly string[]) => warnings.filter(warning => warning.includes(" history starts "));
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
  expect(readParsedHistoryResult(parsedPriceHistoryKey({ symbol: "RETENTION", exchange: "CCC" }, "3M", "15m"))).toBeUndefined();
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
  expect(result.errors).toHaveLength(2);
  expect(result.series.every(series => series.points.length === 0)).toBe(true);
  // A panned window reaching back past the retained bars keeps its dates too.
  const panned = await resolveChartSpecData(chart("RETENTION", "15m", "3M"), sources(provider), undefined,
    { awaitResolutionSupport: true, requestViewport: { start: new Date(NOW - 70 * DAY), end: new Date(NOW - 10 * DAY) } });
  expect(panned.errors).toHaveLength(2);
  expect(calls.some(call => call.kind === "recovery" || call.kind === "default" || call.kind === "1d")).toBe(false);
});

test("an explicit interval on a range longer than the source keeps charts the retained bars from their first day", async () => {
  setSystemTime(NOW);
  const firstBar = proof().availableStart + STEP;
  const { provider, calls, data } = limited({ data: history(firstBar) }), cache = new ChartResolveCache();
  const notice = "15m history starts Jul 24; the source keeps the last 60 days.";
  const result = await resolveChartSpecData(chart("RETENTION", "15m", "3M"), sources(provider), cache, { awaitResolutionSupport: true });
  expect(result.errors).toEqual([]);
  expect(result.resolution).toBe("15m");
  expect(result.series.find(series => series.id === "close")!.points).toHaveLength(data.length);
  expect(result.warnings[0]).toBe(notice);
  expect(retentionNotices(result.warnings)).toEqual([notice]);
  expect(result.viewport).toEqual({ start: new Date(firstBar), end: new Date(NOW) });
  // Live passes reuse the one recovery until the evidence expires.
  await resolveChartSpecData(chart("RETENTION", "15m", "3M"), sources(provider, NOW + 1000), cache, { awaitResolutionSupport: true });
  expect(calls.map(call => call.kind)).toEqual(["15m", "recovery"]);
  expect(calls[1]).toMatchObject({ start: firstBar, end: NOW });
  expect(calls[1]!.context?.historyRecovery).toMatchObject({ sourceKey: "provider:gloomberb-cloud", retention: proof() });
  expect([...cache.priceHistoryExpiryByRequest.values()]).toEqual([NOW + 300_000]);
  // 1M shares the acquisition but starts inside the retained window.
  const month = await resolveChartSpecData(chart("RETENTION", "15m", "1M"), sources(provider), cache, { awaitResolutionSupport: true });
  expect(calls).toHaveLength(2);
  expect(retentionNotices(month.warnings)).toEqual([]);
  expect(month.viewport?.start).toEqual(subtractTimeRange(new Date(NOW), "1M"));
  // Evidence for another interval cannot request the retained window.
  const wrong = limited({ wrongInterval: true });
  const refused = await resolveChartSpecData(chart("RETENTION", "15m", "3M"), sources(wrong.provider), undefined, { awaitResolutionSupport: true });
  expect(refused.errors).toHaveLength(2);
  expect(wrong.calls.some(call => call.kind === "recovery")).toBe(false);
});

test("Auto on a range longer than the source keeps still steps to coarser bars", async () => {
  setSystemTime(NOW);
  const kinds: string[] = [];
  const daily = Array.from({ length: 92 }, (_, index) => ({ date: new Date(NOW - (91 - index) * DAY), close: 100 + index }));
  // Auto charts 3M at hourly bars, which this source keeps for 60 days.
  const provider = createTestDataProvider({ id: "gloomberb-cloud",
    getChartResolutionSupport: async () => [{ resolution: "1h", maxRange: "1Y" }, { resolution: "1d", maxRange: "ALL" }],
    async getPriceHistoryForResolution(_symbol, _exchange, _range, interval) {
      kinds.push(interval);
      if (interval === "1d") return daily;
      throw new HistoryRetentionError(proof("RETENTION", "1h"));
    },
    async getDetailedPriceHistory() { kinds.push("detailed"); return history(); },
  });
  const result = await resolveChartSpecData(chart("RETENTION", "auto", "3M"), sources(provider), undefined, { awaitResolutionSupport: true });
  expect(result.errors).toEqual([]);
  expect(result.resolution).toBe("1d");
  expect(retentionNotices(result.warnings)).toEqual([]);
  expect(result.viewport?.start).toEqual(subtractTimeRange(new Date(NOW), "3M"));
  expect(kinds).toEqual(["1h", "1d"]);
});

test("a listing without a retention limit keeps its whole range at an explicit interval", async () => {
  setSystemTime(NOW);
  const kinds: string[] = [];
  const provider = createTestDataProvider({ id: "gloomberb-cloud",
    getChartResolutionSupport: async () => [{ resolution: "15m", maxRange: "3M" }, { resolution: "1d", maxRange: "ALL" }],
    async getPriceHistoryForResolution(_symbol, _exchange, _range, interval) { kinds.push(interval); return history(NOW - 90 * DAY); },
    async getDetailedPriceHistory() { kinds.push("detailed"); return []; },
  });
  const result = await resolveChartSpecData(chart("AAPL", "15m", "3M", "NASDAQ"), sources(provider), undefined, { awaitResolutionSupport: true });
  expect(result.errors).toEqual([]);
  expect(retentionNotices(result.warnings)).toEqual([]);
  expect(result.viewport).toEqual({ start: subtractTimeRange(new Date(NOW), "3M"), end: new Date(NOW) });
  expect(kinds).toEqual(["15m"]);
});

test("the retained window's first day reads in the listing's zone", () => {
  const evidence = { ...proof(), availableStart: Date.parse("2026-08-03T22:30:00Z"), observedAt: Date.parse("2026-10-02T22:30:00Z") };
  expect(historyRetentionNotice(evidence, "30m", "Europe/Helsinki")).toBe("30m history starts Aug 4; the source keeps the last 60 days.");
  expect(historyRetentionNotice(evidence, "30m", null)).toBe("30m history starts Aug 3; the source keeps the last 60 days.");
  const lastYear = { ...evidence, availableStart: Date.parse("2025-12-20T12:00:00Z"), observedAt: Date.parse("2026-01-02T12:00:00Z") };
  expect(historyRetentionNotice(lastYear, "1m", "Europe/Helsinki")).toBe("1m history starts Dec 20, 2025; the source keeps the last 13 days.");
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
