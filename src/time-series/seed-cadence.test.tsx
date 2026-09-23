import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { createTestDataProvider } from "../test-support/data-provider";
import { setSharedMarketDataCoordinator } from "../market-data/coordinator";
import { createIdleEntry } from "../market-data/result-types";
import { IDLE_COORDINATOR_QUOTES } from "./fixtures/quote-store";
import { parsedPriceHistoryKey, readParsedHistoryResult, readParsedPriceHistory, rememberParsedPriceHistory } from "./parsed-history-cache";
import { useChartResolution, type UseChartResolutionResult } from "./use-chart-resolution";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";
import type { PricePoint } from "../types/financials";
import type { ChartRequest } from "../market-data/request-types";
import type { HistorySession, PriceHistoryResult } from "../types/price-history";
import type { ChartResolveOptions } from "./resolve";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  setSharedMarketDataCoordinator(null);
  setSystemTime();
});

const weekly: PricePoint[] = [
  { date: new Date("2026-09-07"), close: 81_000, volume: 204_000_000_000 },
  { date: new Date("2026-09-14"), close: 82_000, volume: 205_000_000_000 },
];
const daily: PricePoint[] = [
  { date: new Date("2026-09-20"), close: 85_000, volume: 58_000_000_000 },
  { date: new Date("2026-09-21"), close: 86_000, volume: 59_000_000_000 },
];

async function mount(spec: ChartSpec, now = new Date("2026-09-22T12:00:00Z"), options: ChartResolveOptions = {}) {
  let resolve!: (points: PricePoint[]) => void;
  const waiting = new Promise<PricePoint[]>(done => { resolve = done; });
  let requested = false;
  let latest!: UseChartResolutionResult;
  const sources = {
    now,
    dataProvider: createTestDataProvider({
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getPriceHistoryForResolution: async () => { requested = true; return waiting; },
      getDetailedPriceHistory: async () => { requested = true; return waiting; },
    }),
    loadFredSeries: async () => { throw new Error("Unexpected FRED request"); },
  };
  function Harness() {
    latest = useChartResolution(spec, sources, { ...options, liveStreaming: false, liveRefreshIntervalMs: 0 });
    return <text>{JSON.stringify({ loading: latest.loading, resolution: latest.resolution,
      series: latest.series.map(s => [s.id, s.points.map(p => p.value)]) })}</text>;
  }
  setup = await testRender(<Harness />, { width: 160, height: 2 });
  const settle = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      await act(async () => { await Bun.sleep(1); await setup!.renderOnce(); });
      if (predicate()) return;
    }
    throw new Error(`Chart did not settle: ${setup!.captureCharFrame()}`);
  };
  await settle(() => requested);
  return { current: () => latest, async finish(points: PricePoint[]) {
    await act(async () => resolve(points));
    await settle(() => !latest.loading);
  } };
}

function specFor(symbol: string, viewport: ChartSpec["viewport"]): ChartSpec {
  return {
    version: CHART_SPEC_VERSION, viewport, panels: [{ id: "main" }, { id: "volume" }],
    series: [{ id: "price", panelId: "main", style: "line", transform: "raw", interpolation: "none", axis: "left",
      source: { kind: "security", instrument: { symbol, exchange: "CCC" }, fieldId: "market.close" } }],
    studies: [{ id: "volume", kind: "volume", inputSeriesIds: ["price"], parameters: {}, panelId: "volume", axis: "left" }],
  };
}

for (const source of ["parsed", "coordinator"] as const) {
  for (const hasDaily of [false, true]) {
    test(`${source} weekly baseline never supplies daily price or volume; daily cached=${hasDaily}`, async () => {
      const spec = specFor(`CADENCE-${source}-${hasDaily}`, { range: "1M", resolution: "1d" });
      const instrument = { symbol: `CADENCE-${source}-${hasDaily}`, exchange: "CCC" };
      if (source === "parsed") {
        rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "ALL", "1wk"), weekly);
        if (hasDaily) rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "1M", "1d"), daily);
      } else {
        setSharedMarketDataCoordinator({
          ...IDLE_COORDINATOR_QUOTES,
          subscribe: () => () => {}, getVersion: () => 1,
          getChartEntry: (request: ChartRequest) => {
            const points = request.resolution === "1wk" ? weekly : hasDaily && request.resolution === "1d" ? daily : null;
            return { ...createIdleEntry<PricePoint[]>(), phase: "ready", data: points, lastGoodData: points };
          },
        } as never);
      }
      const view = await mount(spec);
      expect(view.current().loading).toBe(true);
      if (hasDaily) {
        expect(view.current().resolution).toBe("1d");
        expect(view.current().series.find(s => s.id === "price")?.points.map(p => p.value)).toEqual([85_000, 86_000]);
        expect(view.current().series.find(s => s.id === "volume")?.points.map(p => p.value)).toEqual([58_000_000_000, 59_000_000_000]);
      } else expect(view.current().series).toEqual([]);
      await view.finish(daily);
      expect(view.current().resolution).toBe("1d");
      expect(view.current().series.find(s => s.id === "price")?.points.map(p => p.value)).toEqual([85_000, 86_000]);
    });
  }
}

for (const resolution of ["auto", "1wk"] as const) {
  test(`weekly baseline still seeds a compatible ${resolution} chart`, async () => {
    const spec = specFor(`WEEKLY-${resolution}`, { range: "5Y", resolution });
    rememberParsedPriceHistory(parsedPriceHistoryKey({ symbol: `WEEKLY-${resolution}`, exchange: "CCC" }, "ALL", "1wk"), weekly);
    const view = await mount(spec);
    expect(view.current().resolution).toBe("1wk");
    expect(view.current().series.find(s => s.id === "price")?.points.map(p => p.value)).toEqual([81_000, 82_000]);
    expect(view.current().series.find(s => s.id === "volume")?.points.map(p => p.value)).toEqual([204_000_000_000, 205_000_000_000]);
    await view.finish(weekly);
  });
}

test("manual daily seeds retain earlier study inputs outside an explicit visible window", async () => {
  const spec = specFor("DAILY-STUDY", { range: "5Y", resolution: "1d", dateWindow: { start: "2026-09-20", end: "2026-09-21" } });
  spec.studies.push({ id: "average", kind: "sma", inputSeriesIds: ["price"], parameters: { period: 3 }, panelId: "main", axis: "left" });
  const buffered = [{ date: new Date("2026-09-18"), close: 83_000, volume: 56_000_000_000 },
    { date: new Date("2026-09-19"), close: 84_000, volume: 57_000_000_000 }, ...daily];
  const instrument = { symbol: "DAILY-STUDY", exchange: "CCC" };
  rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "ALL", "1wk"), weekly);
  rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "ALL", "1d"), buffered);
  const view = await mount(spec);
  expect(view.current().resolution).toBe("1d");
  expect(view.current().series.find(s => s.id === "price")?.points.map(p => p.value)).toEqual([85_000, 86_000]);
  expect(view.current().series.find(s => s.id === "average")?.points.map(p => p.value)).toEqual([84_000, 85_000]);
  expect(view.current().bufferedSeries?.find(s => s.id === "price")?.points).toHaveLength(4);
  await view.finish(buffered);
  expect(view.current().series.find(s => s.id === "average")?.points.map(p => p.value)).toEqual([84_000, 85_000]);
});

test("Auto honors a daily market period when choosing a seed for a long range", async () => {
  const spec = specFor("AUTO-DAILY-PERIOD", { range: "5Y", resolution: "auto" });
  if (spec.series[0]!.source.kind === "security") spec.series[0]!.source.period = "daily";
  const instrument = { symbol: "AUTO-DAILY-PERIOD", exchange: "CCC" };
  rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "ALL", "1wk"), weekly);
  rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "ALL", "1d"), daily);
  const view = await mount(spec);
  expect(view.current().resolution).toBe("1d");
  expect(view.current().series.find(s => s.id === "price")?.points.map(p => p.value)).toEqual([85_000, 86_000]);
  await view.finish(daily);
  expect(view.current().resolution).toBe("1d");
});

test("Auto date-window seeds use the authored duration instead of the ALL preset", async () => {
  const spec = specFor("AUTO-EXPLICIT", { range: "ALL", resolution: "auto", dateWindow: { start: "2026-08-22", end: "2026-09-22" } });
  const instrument = { symbol: "AUTO-EXPLICIT", exchange: "CCC" };
  const intraday = [0, 1].map(index => ({ date: new Date(Date.UTC(2026, 8, 22, 11, 30 + index * 15)), close: 85_001 + index, volume: 1_000 + index }));
  rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "ALL", "1wk"), weekly);
  rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "ALL", "15m"), intraday);
  const view = await mount(spec);
  expect(view.current().resolution).toBe("15m");
  expect(view.current().series.find(s => s.id === "price")?.points.map(p => p.value)).toEqual([85_001, 85_002]);
  expect(view.current().series.find(s => s.id === "volume")?.points.map(p => p.value)).toEqual([1_000, 1_001]);
  await view.finish(intraday);
  expect(view.current().resolution).toBe("15m");
});

const sessionPoints: PricePoint[] = [30, 45].map(minute => ({
  date: new Date(Date.UTC(2026, 8, 21, 19, minute)), close: 100 + minute, volume: minute,
}));
const PREOPEN = Date.parse("2026-09-22T12:42:00Z");

for (const cache of ["parsed", "coordinator"] as const) {
  for (const scenario of ["preopen", "first-bar-due", "unknown", "wrong-target", "wrong-cadence", "historical", "historical-pan"] as const) {
    test(`${cache} loading seeds validate acquisition metadata before rendering ${scenario}`, async () => {
      const now = scenario === "first-bar-due" ? Date.parse("2026-09-22T14:00:00Z") : PREOPEN;
      setSystemTime(now);
      const symbol = `SESSION-${cache}-${scenario}`.toUpperCase();
      const instrument = { symbol, exchange: "NASDAQ" };
      const spec = specFor(symbol, { range: "1M", resolution: "15m",
        ...(scenario === "historical" ? { dateWindow: { start: "2026-09-21", end: "2026-09-21" } } : {}),
      });
      if (spec.series[0]!.source.kind === "security") spec.series[0]!.source.instrument = instrument;
      const session: HistorySession = { version: 1, kind: "regular", calendar: "us-equity", timeZone: "America/New_York",
        symbol: scenario === "wrong-target" ? "MSFT" : symbol, exchange: "NASDAQ", interval: "15min", source: "yahoo",
        timestampConvention: "bar-open", barAlignment: "session-open",
        observedAt: scenario.startsWith("historical") ? Date.parse("2026-09-21T19:50:00Z") : PREOPEN,
      };
      const metadata: Omit<PriceHistoryResult, "points"> = { resolution: scenario === "wrong-cadence" ? "1h" : "15m",
        ...(scenario === "unknown" ? {} : { session }), sourceKey: "provider:actual-source" };
      if (cache === "parsed") rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "1M", "15m"), sessionPoints, metadata);
      else {
        // A stale first cache must not mask a fresh coordinator acquisition.
        if (scenario === "preopen") rememberParsedPriceHistory(parsedPriceHistoryKey(instrument, "1M", "15m"), sessionPoints,
          { ...metadata, session: { ...session, observedAt: Date.parse("2026-09-21T19:50:00Z") } });
        setSharedMarketDataCoordinator({ ...IDLE_COORDINATOR_QUOTES, subscribe: () => () => {}, getVersion: () => 1,
          getChartEntry: () => ({ ...createIdleEntry<PricePoint[]>(), phase: "ready", data: sessionPoints,
            lastGoodData: sessionPoints, history: metadata }),
        } as never);
      }
      const view = await mount(spec, new Date(now), scenario === "historical-pan"
        ? { requestViewport: { start: new Date("2026-09-21T19:30:00Z"), end: new Date("2026-09-21T19:45:00Z") } } : {});
      expect(view.current().loading).toBe(true);
      const expected = scenario === "preopen" || scenario.startsWith("historical") ? [130, 145] : [];
      expect(view.current().series.find(series => series.id === "price")?.points.map(point => point.value) ?? []).toEqual(expected);
      expect(view.current().series.find(series => series.id === "volume")?.points.map(point => point.value) ?? [])
        .toEqual(expected.length ? [30, 45] : []);
      await view.finish([]);
    });
  }
}

test("parsed cache replaces provenance together with points and keeps its existing 32-entry bound", () => {
  const key = "paired-history-regression";
  rememberParsedPriceHistory(key, sessionPoints, { resolution: "15m", sourceKey: "provider:first" });
  expect(readParsedHistoryResult(key)?.sourceKey).toBe("provider:first");
  rememberParsedPriceHistory(key, daily);
  expect(readParsedHistoryResult(key)).toEqual({ points: daily, resolution: null });
  expect(readParsedPriceHistory(key)).toBe(daily);
  for (let i = 0; i < 32; i++) rememberParsedPriceHistory(`bounded-history-${i}`, daily, { resolution: "1d" });
  expect(readParsedHistoryResult(key)).toBeUndefined();
  expect(readParsedPriceHistory("bounded-history-0")).toBe(daily);
});
