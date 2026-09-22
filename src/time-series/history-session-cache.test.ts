import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import type { HistorySession, PriceHistoryResult } from "../types/price-history";
import type { TickerFinancials } from "../types/financials";
import type { HeadlessPaneContext } from "../types/headless";
import { ChartResolveCache, resolveChartSpecData } from "./resolve";
import type { ChartSpec } from "./types";
import { chartHeadless, loadChartPaneModel, type ChartPaneModel } from "../plugins/builtin/chart-composer/headless";
import { createSnapshotDataProvider } from "../market-data/snapshot-provider";
import { fetchHistoryResult } from "../sources/history-result";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { createDefaultConfig } from "../types/config";

const time = (value: string) => Date.parse(value);
const NOW = time("2026-09-22T12:42:00Z");
const history = [9, 10, 11, 14, 15, 16, 17, 18, 21].flatMap((day, session) => Array.from({ length: 26 }, (_, bar) => ({
  date: new Date(Date.UTC(2026, 8, day, 13, 30) + bar * 900_000), close: 100 + session * 26 + bar, volume: 10 + bar,
})));
const session = (observedAt = NOW): HistorySession => ({ version: 1, kind: "regular", calendar: "us-equity", timeZone: "America/New_York",
  symbol: "AAPL", exchange: "NASDAQ", interval: "15min", source: "yahoo", timestampConvention: "bar-open", barAlignment: "session-open", observedAt });
const result = (observedAt = Date.now(), points = history): PriceHistoryResult => ({ points, resolution: "15m", session: session(observedAt), sourceKey: "provider:actual-history-source" });
const chart = (): ChartSpec => ({ version: 2, viewport: { range: "1M", resolution: "15m" }, panels: [{ id: "main" }],
  series: ["close", "volume"].map(field => ({ id: field, source: { kind: "security", instrument: { symbol: "AAPL", exchange: "NASDAQ" }, fieldId: `market.${field}` },
    style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" })),
  studies: [{ id: "sma", kind: "sma", inputSeriesIds: ["close"], parameters: { period: 200 }, panelId: "main", axis: "left" }],
});
const provider = (get: () => Promise<PriceHistoryResult>) => createTestDataProvider({ id: "preferred-router-id",
  getQuoteMetadata: async symbol => ({ symbol, currency: "USD", instrumentType: "EQUITY" }),
  getChartResolutionSupport: () => [{ resolution: "15m", maxRange: "ALL" }],
  getPriceHistoryForResolution: async () => { throw new Error("The array projection must not replace the actual metadata acquisition"); },
  getPriceHistoryForResolutionWithMetadata: get,
});
afterEach(() => setSystemTime());

test("price, volume and SMA200 share a current history acquisition and refresh exactly when the first new-session bar is due", async () => {
  setSystemTime(NOW);
  let calls = 0;
  const next = [...history, { date: new Date("2026-09-22T13:30:00Z"), close: 340, volume: 50 }, { date: new Date("2026-09-22T13:45:00Z"), close: 341, volume: 51 }];
  const dataProvider = provider(async () => { calls++; return result(Date.now(), Date.now() < time("2026-09-22T14:00:00Z") ? history : next); });
  const cache = new ChartResolveCache(), spec = chart(), captures: TickerFinancials[] = [];
  const resolve = () => resolveChartSpecData(spec, { dataProvider, now: new Date(), onSecurityData: (_spec, value) => captures.push(value) }, cache);
  const first = await resolve();
  expect(first.errors).toEqual([]);
  expect(first.series.find(series => series.id === "close")!.points).toHaveLength(234);
  expect(first.series.find(series => series.id === "sma")!.points.at(-1)!.value).toBe(233.5);
  expect(captures.every(value => value.priceHistorySourceKey === "provider:actual-history-source" && value.priceHistorySession?.observedAt === NOW)).toBe(true);
  setSystemTime(time("2026-09-22T13:59:59Z"));
  await resolve();
  expect(calls).toBe(1);
  setSystemTime(time("2026-09-22T14:00:00Z"));
  const current = await resolve();
  expect(current.errors).toEqual([]);
  expect(current.series.find(series => series.id === "close")!.points.at(-1)!.value).toBe(341);
  expect(calls).toBe(2);
  setSystemTime(time("2026-09-22T14:00:01Z"));
  await resolve();
  expect(calls).toBe(2);
});

test("unfinished closing acquisitions are rejected and retried on a finite shared cooldown without quote-tick storms", async () => {
  const closing = time("2026-09-21T20:20:00Z");
  setSystemTime(closing);
  let calls = 0, recovered = false;
  const dataProvider = provider(async () => { calls++; return result(recovered ? Date.now() : time("2026-09-21T19:50:00Z")); });
  const cache = new ChartResolveCache(), spec = chart();
  const resolve = () => resolveChartSpecData(spec, { dataProvider, now: new Date() }, cache);
  expect((await resolve()).series.every(series => series.points.length === 0)).toBe(true);
  for (const elapsed of [1000, 2000, 29_999]) { setSystemTime(closing + elapsed); expect((await resolve()).errors.length).toBeGreaterThan(0); }
  expect(calls).toBe(1);
  setSystemTime(closing + 30_000);
  expect((await resolve()).errors.length).toBeGreaterThan(0);
  expect(calls).toBe(2);
  setSystemTime(closing + 30_001);
  await resolve();
  expect(calls).toBe(2);
  recovered = true;
  setSystemTime(closing + 60_000);
  expect((await resolve()).errors).toEqual([]);
  expect(calls).toBe(3);
});

test("explicit historical windows retain their captured observations across later sessions", async () => {
  setSystemTime(NOW);
  let calls = 0;
  const dataProvider = provider(async () => { calls++; return result(time("2026-09-21T19:50:00Z")); });
  const spec = chart();
  spec.viewport.dateWindow = { start: "2026-09-09", end: "2026-09-21" };
  const cache = new ChartResolveCache();
  const first = await resolveChartSpecData(spec, { dataProvider, now: new Date() }, cache);
  setSystemTime(time("2026-09-23T15:00:00Z"));
  const later = await resolveChartSpecData(spec, { dataProvider, now: new Date() }, cache);
  expect(first.errors).toEqual([]);
  expect(later.errors).toEqual([]);
  expect(later.series.map(series => series.points)).toEqual(first.series.map(series => series.points));
  expect(calls).toBe(1);
});

test("recent explicit windows revalidate across the opening boundary just like current trailing windows", async () => {
  setSystemTime(NOW);
  let calls = 0;
  const dataProvider = provider(async () => { calls++; return result(); });
  const spec = chart();
  spec.viewport.dateWindow = { start: "2026-09-09T13:30:00Z", end: "2026-09-22T14:00:00Z" };
  const cache = new ChartResolveCache();
  expect((await resolveChartSpecData(spec, { dataProvider, now: new Date() }, cache)).errors).toEqual([]);
  expect(calls).toBe(1);
  setSystemTime(time("2026-09-22T14:00:00Z"));
  expect((await resolveChartSpecData(spec, { dataProvider, now: new Date() }, cache)).series.every(series => series.points.length === 0)).toBe(true);
  expect(calls).toBe(2);
});

test("live quote tails stay separate from their earlier history acquisition during snapshot replay", async () => {
  setSystemTime(time("2026-09-22T14:05:00Z"));
  const acquired = [...history, { date: new Date("2026-09-22T13:30:00Z"), close: 340, volume: 50 }];
  const dataProvider = provider(async () => result(time("2026-09-22T13:59:00Z"), acquired));
  const spec = chart();
  const source = spec.series[0]!.source;
  if (source.kind !== "security") throw new Error("Expected security source");
  const quoteKey = chartQuoteOverrideKeyForSource(source);
  const quote = { symbol: "AAPL", currency: "USD", instrumentType: "EQUITY", listingExchangeName: "NASDAQ", price: 345,
    change: 5, changePercent: 1, marketState: "REGULAR" as const, lastUpdated: time("2026-09-22T14:05:00Z") };
  let captured: TickerFinancials | undefined;
  const first = await resolveChartSpecData(spec, { dataProvider, now: new Date(), quoteOverrides: new Map([[quoteKey, quote]]),
    onSecurityData: (_spec, value) => { captured = value; } });
  expect(first.errors).toEqual([]);
  expect(first.series.find(series => series.id === "close")!.points.at(-1)!.value).toBe(345);
  expect(captured!.priceHistory).toEqual(acquired);
  expect(captured!.priceHistorySession?.observedAt).toBe(time("2026-09-22T13:59:00Z"));
  expect(captured!.quote).toEqual(quote);
  const payload = JSON.parse(JSON.stringify({ financials: [["AAPL:NASDAQ", captured!]] }));
  const replay = await resolveChartSpecData(spec, { dataProvider: createSnapshotDataProvider(payload, createTestDataProvider()), now: new Date(),
    quoteOverrides: new Map([[quoteKey, captured!.quote!]]) });
  expect(replay.errors).toEqual([]);
  expect(replay.series.map(series => series.points)).toEqual(first.series.map(series => series.points));
});

test("JSON snapshots retain actual session, source and acquisition time through every history method without live substitution", async () => {
  setSystemTime(NOW);
  const dataProvider = provider(async () => result());
  const model = await loadChartPaneModel(chart(), { marketData: dataProvider } as HeadlessPaneContext);
  expect(model.errors).toEqual([]);
  const captured = model.snapshot.financials[0]![1];
  expect(captured.priceHistorySession).toEqual(session());
  expect(captured.priceHistorySourceKey).toBe("provider:actual-history-source");
  let liveCalls = 0;
  const fallback = provider(async () => { liveCalls++; throw new Error("Captured metadata must be authoritative"); });
  fallback.getDetailedPriceHistoryWithMetadata = async () => { liveCalls++; throw new Error("Captured detail must be authoritative"); };
  const replayProvider = createSnapshotDataProvider(JSON.parse(JSON.stringify(model.snapshot)), fallback);
  expect((await replayProvider.getDetailedPriceHistory!("AAPL", "NASDAQ", new Date("2026-09-21T19:30:00Z"), new Date("2026-09-21T20:00:00Z"), "15min")).map(point => point.close)).toEqual([332, 333]);
  for (const request of [
    { kind: "range", range: "1M" }, { kind: "resolution", range: "1M", resolution: "15m" },
    { kind: "detail", start: new Date("2026-09-21T19:30:00Z"), end: new Date("2026-09-21T20:00:00Z"), interval: "15min" },
  ] as const) {
    const loaded = await fetchHistoryResult(replayProvider, "AAPL", "NASDAQ", request);
    expect(loaded?.session).toEqual(session());
    expect(loaded?.sourceKey).toBe("provider:actual-history-source");
    expect(loaded?.points.length).toBeGreaterThan(0);
  }
  const replay = await loadChartPaneModel(chart(), { marketData: replayProvider } as HeadlessPaneContext);
  expect(replay.errors).toEqual([]);
  expect(replay.chart.series.map(series => series.points)).toEqual(model.chart.series.map(series => series.points));
  expect(liveCalls).toBe(0);
  const corrupted = createSnapshotDataProvider({ financials: [["AAPL:NASDAQ", { ...captured, priceHistorySession: { ...session(), symbol: "MSFT" } }]] }, fallback);
  await expect(corrupted.getPriceHistory("AAPL", "NASDAQ", "1M")).rejects.toThrow("invalid acquisition metadata");
  await expect(corrupted.getPriceHistoryForResolution!("AAPL", "NASDAQ", "1M", "15m")).rejects.toThrow("invalid acquisition metadata");
  await expect(corrupted.getDetailedPriceHistory!("AAPL", "NASDAQ", new Date("2026-09-21"), new Date("2026-09-22"), "15min")).rejects.toThrow("invalid acquisition metadata");
  expect(liveCalls).toBe(0);
});

test("loading an earlier research window cannot give accumulated later bars a newer acquisition time", async () => {
  setSystemTime(NOW);
  let acquired = result();
  const dataProvider = provider(async () => acquired);
  dataProvider.getDetailedPriceHistoryWithMetadata = async () => acquired;
  const spec = chart();
  spec.series = spec.series.slice(0, 1);
  spec.studies = [];
  spec.viewport.dateWindow = { start: "2026-09-09", end: "2026-09-21" };
  const cache = new ChartResolveCache();
  let captured: TickerFinancials | undefined;
  const resolve = () => resolveChartSpecData(spec, { dataProvider, now: new Date(),
    onSecurityData: (_series, data) => { captured = data; } }, cache);
  expect((await resolve()).errors).toEqual([]);
  setSystemTime(NOW + 1000);
  acquired = result(Date.now(), history.slice(0, -26));
  spec.viewport.dateWindow = { start: "2026-09-09", end: "2026-09-18" };
  expect((await resolve()).errors).toEqual([]);
  expect(captured!.priceHistory).toEqual(history);
  expect(captured!.priceHistorySession?.observedAt).toBe(NOW);
  expect(captured!.priceHistorySourceKey).toBe(acquired.sourceKey!);
});

test("GIP captures preserve source session metadata separately from requested session dates", async () => {
  setSystemTime(NOW);
  for (const requestedSession of [undefined, "2026-09-18"] as const) {
    let calls = 0;
    const dataProvider = provider(async () => { calls++; return result(); });
    dataProvider.getDetailedPriceHistoryWithMetadata = async () => { calls++; return result(); };
    const spec = chart();
    spec.viewport.range = "1D";
    spec.studies = [];
    const context: HeadlessPaneContext = { marketData: dataProvider, settings: { chartSpec: spec },
      apiClient: {} as HeadlessPaneContext["apiClient"], config: createDefaultConfig(":memory:"), signal: new AbortController().signal };
    const args = { argument: "AAPL:NASDAQ", rawArgument: "AAPL:NASDAQ", symbols: ["AAPL:NASDAQ"],
      options: requestedSession ? { session: requestedSession } : {} };
    const definition = chartHeadless("graph-intraday-price-pane");
    const model = await definition.load(args, context) as ChartPaneModel;
    expect(model.errors).toEqual([]);
    expect(calls).toBe(1);
    expect(model.snapshot.intradayHistories[0]!.session).toEqual(session());
    expect(model.snapshot.intradayHistories[0]!.requestedSession).toBe(requestedSession ?? null);
    expect(model.snapshot.intradayHistories[0]!.sourceKey).toBe("provider:actual-history-source");
    expect(model.snapshot.financials[0]![1].priceHistorySession).toEqual(session());
    const replay = await definition.load(args, { ...context,
      marketData: createSnapshotDataProvider(JSON.parse(JSON.stringify(model.snapshot)), dataProvider) }) as ChartPaneModel;
    expect(replay.errors).toEqual([]);
    expect(replay.chart.series.map(series => series.points)).toEqual(model.chart.series.map(series => series.points));
    expect(calls).toBe(1);
  }
});
