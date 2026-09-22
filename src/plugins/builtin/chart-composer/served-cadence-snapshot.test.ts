import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createSnapshotDataProvider } from "../../../market-data/snapshot-provider";
import { HistoryRetentionError } from "../../../sources/history-retention";
import type { HeadlessPaneContext } from "../../../types/headless";
import { loadChartPaneModel } from "./headless";
import { buildCustomChartPreset, buildPriceChartPreset } from "./presets";

const daily = [100, 105, 103, 108].map((close, index) => ({ date: new Date(Date.UTC(2026, 8, index + 1)), close, volume: 10 + index }));
const fine = [1, 2, 3, 4].map((close, index) => ({ date: new Date(Date.UTC(2026, 8, 1, 9, index * 15)), close, volume: 20 + index }));
const metadata = (symbol: string) => ({ symbol, currency: "USD", instrumentType: "EQUITY" });
const window = { range: "1M" as const, resolution: "auto" as const, dateWindow: { start: "2026-09-01", end: "2026-09-05" } };
const NOW = Date.parse("2026-09-22T12:00:00Z"), DAY = 86_400_000;
afterEach(() => setSystemTime());

test("an AUTO default-only chart captures and replays raw unknown-cadence history without manufacturing daily or intraday provenance", async () => {
  setSystemTime(NOW);
  const spec = buildPriceChartPreset("DEFAULT:NASDAQ");
  spec.viewport = window;
  let defaultCalls = 0;
  const provider = createTestDataProvider({
    getPriceHistory: async () => { defaultCalls++; return daily; },
    getQuoteMetadata: async (symbol) => metadata(symbol),
  });
  const model = await loadChartPaneModel(spec, { marketData: provider } as HeadlessPaneContext);
  expect(model.errors).toEqual([]);
  expect(model.chart.resolution).toBeUndefined();
  expect(model.chart.series[0]!.historyResolution).toBeNull();
  expect(model.chart.series[0]!.nativeFrequency).toBe("auto");
  expect(model.snapshot.financials[0]![1].priceHistoryResolution).toBeNull();
  expect(model.snapshot.financials[0]![1].priceHistory).toEqual(daily);
  expect(model.snapshot.intradayHistories).toEqual([]);
  expect(defaultCalls).toBe(1);
  const wrapped = await loadChartPaneModel(spec, { marketData: createSnapshotDataProvider({ financials: [] }, provider) } as HeadlessPaneContext);
  expect(wrapped.chart.series).toEqual(model.chart.series);
  expect(wrapped.chart.resolution).toBeUndefined();
  expect(defaultCalls).toBe(2);
  let liveCalls = 0;
  const replay = await loadChartPaneModel(spec, { marketData: createSnapshotDataProvider(JSON.parse(JSON.stringify(model.snapshot)), createTestDataProvider({
    getPriceHistory: async () => { liveCalls++; throw new Error("Snapshot must retain its captured history"); },
  })) } as HeadlessPaneContext);
  expect(replay.chart.series.map(series => ({ historyResolution: series.historyResolution, points: series.points })))
    .toEqual(model.chart.series.map(series => ({ historyResolution: series.historyResolution, points: series.points })));
  expect(replay.chart.resolution).toBeUndefined();
  expect(replay.snapshot.financials[0]![1].priceHistoryResolution).toBeNull();
  expect(liveCalls).toBe(0);
});

test("different assets retain individually served AUTO cadences through capture and replay", async () => {
  setSystemTime(NOW);
  const spec = buildCustomChartPreset("FINE:NASDAQ:market.close,DAILY:NASDAQ:market.close");
  spec.viewport = window;
  const calls: string[] = [];
  const provider = createTestDataProvider({
    getQuoteMetadata: async symbol => metadata(symbol),
    getChartResolutionSupport: symbol => symbol === "FINE"
      ? [{ resolution: "15m", maxRange: "ALL" }]
      : [{ resolution: "15m", maxRange: "3M" }, { resolution: "1d", maxRange: "ALL" }],
    getPriceHistoryForResolution: async (symbol, _exchange, _range, resolution) => {
      calls.push(`${symbol}:${resolution}`);
      if (symbol === "DAILY" && resolution === "15m") throw new HistoryRetentionError({
        version: 1, source: "yahoo", symbol, exchange: "NASDAQ", interval: "15min",
        requestedStart: NOW - 92 * DAY, requestedEnd: NOW, observedAt: NOW, availableStart: NOW - 60 * DAY,
      });
      if (resolution !== (symbol === "FINE" ? "15m" : "1d")) throw new Error("Unsupported interval");
      return symbol === "FINE" ? fine : daily;
    },
  });
  const model = await loadChartPaneModel(spec, { marketData: provider } as HeadlessPaneContext);
  expect(model.errors).toEqual([]);
  expect(model.chart.resolution).toBeUndefined();
  expect(model.chart.series.map(series => series.historyResolution)).toEqual(["15m", "1d"]);
  expect(calls.sort()).toEqual(["DAILY:15m", "DAILY:1d", "FINE:15m"]);
  expect(model.snapshot.financials.map(([, data]) => data.priceHistoryResolution).sort()).toEqual(["15m", "1d"]);
  const replay = await loadChartPaneModel(spec, { marketData: createSnapshotDataProvider(JSON.parse(JSON.stringify(model.snapshot)), createTestDataProvider()) } as HeadlessPaneContext);
  expect(replay.errors).toEqual([]);
  expect(replay.chart.series.map(series => ({ resolution: series.historyResolution, points: series.points })))
    .toEqual(model.chart.series.map(series => ({ resolution: series.historyResolution, points: series.points })));
});

test("market and valuation defaults for one instrument keep separate observations and stable request identities on replay", async () => {
  setSystemTime(NOW);
  const spec = buildCustomChartPreset("OPAQUE:NASDAQ:market.close,OPAQUE:NASDAQ:valuation.trailingPE");
  spec.viewport = window;
  if (spec.series[1]!.source.kind === "security") spec.series[1]!.source.period = "annual";
  const valuation = [{ date: new Date("2025-12-31"), close: 90 }, ...daily.map(point => ({ ...point, close: point.close * 2 }))];
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({
      quote: { symbol: "OPAQUE", currency: "USD", price: 100, change: 0, changePercent: 0, lastUpdated: 1 },
      statementHistory: { mode: "extended", source: "sec", status: "available", fetchedAt: new Date(NOW).toISOString() },
      annualStatements: [{ date: "2025-12-31", availableAt: "2026-09-01", currency: "USD", eps: 10 }],
      quarterlyStatements: [], priceHistory: [], quoteMetadata: metadata("OPAQUE"), financialCurrency: "USD",
    }),
    getQuoteMetadata: async symbol => metadata(symbol),
    getPriceHistory: async (_symbol, _exchange, range) => {
      if (range === "ALL") return valuation;
      await Bun.sleep(2);
      return daily;
    },
  });
  const model = await loadChartPaneModel(spec, { marketData: provider } as HeadlessPaneContext);
  expect(model.errors).toEqual([]);
  expect(model.chart.series[1]!.points.map(point => point.value)).toEqual([20]);
  expect(model.snapshot.financials[0]![1].priceHistory).toEqual(daily);
  expect(model.snapshot.historyVariants).toHaveLength(2);
  const variants = model.snapshot.historyVariants!;
  expect(variants.every(entry => entry.resolution === null && !!entry.requestKey)).toBe(true);
  expect(new Set(variants.map(entry => entry.requestKey)).size).toBe(2);
  expect(variants.find(entry => entry.requestKey === model.snapshot.financials[0]![1].priceHistoryRequestKey)?.points).toEqual(daily);
  expect(variants.some(entry => entry.points.length === valuation.length && entry.points.at(-1)!.close === 216)).toBe(true);
  let liveCalls = 0;
  const replay = await loadChartPaneModel(spec, { marketData: createSnapshotDataProvider(JSON.parse(JSON.stringify(model.snapshot)), createTestDataProvider({
    getPriceHistory: async () => { liveCalls++; throw new Error("Captured variants must answer their original requests"); },
  })) } as HeadlessPaneContext);
  expect(replay.errors).toEqual([]);
  expect(replay.chart.series.map(series => ({ resolution: series.historyResolution, points: series.points })))
    .toEqual(model.chart.series.map(series => ({ resolution: series.historyResolution, points: series.points })));
  expect(JSON.parse(JSON.stringify(replay.snapshot.historyVariants))).toEqual(JSON.parse(JSON.stringify(model.snapshot.historyVariants)));
  expect(liveCalls).toBe(0);
});

test("one instrument's finer market capture cannot substitute for its separately acquired calendar valuation history", async () => {
  setSystemTime(NOW);
  const spec = buildCustomChartPreset("MIXED:NASDAQ:market.close,MIXED:NASDAQ:valuation.trailingPE,MIXED:NASDAQ:valuation.pegRatio");
  spec.viewport = window;
  if (spec.series[1]!.source.kind === "security") spec.series[1]!.source.period = "annual";
  const provider = createTestDataProvider({
    getTickerFinancials: async (_symbol, _exchange, context) => {
      if (context?.statementHistory !== "extended") {
        await Bun.sleep(2);
        return { annualStatements: [{ date: "2024-12-31", eps: 50 }], quarterlyStatements: [], priceHistory: [] };
      }
      return {
        quote: { symbol: "MIXED", currency: "USD", price: 100, change: 0, changePercent: 0, lastUpdated: 1 },
        statementHistory: { mode: "extended", source: "sec", status: "available", fetchedAt: new Date(NOW).toISOString() },
        annualStatements: [{ date: "2025-12-31", availableAt: "2026-09-01", currency: "USD", eps: 10 }],
        quarterlyStatements: [], priceHistory: [], quoteMetadata: metadata("MIXED"), financialCurrency: "USD",
      };
    },
    getQuoteMetadata: async symbol => metadata(symbol),
    getChartResolutionSupport: () => [{ resolution: "15m", maxRange: "ALL" }, { resolution: "1d", maxRange: "ALL" }],
    getPriceHistoryForResolution: async (symbol, _exchange, range, resolution) => {
      if (range === "ALL" && resolution === "15m") throw new HistoryRetentionError({
        version: 1, source: "yahoo", symbol, exchange: "NASDAQ", interval: "15min",
        requestedStart: NOW - 92 * DAY, requestedEnd: NOW, observedAt: NOW, availableStart: NOW - 60 * DAY,
      });
      return resolution === "15m" ? fine : daily;
    },
  });
  const model = await loadChartPaneModel(spec, { marketData: provider } as HeadlessPaneContext);
  expect(model.errors).toEqual([]);
  expect(model.chart.series[1]!.points.map(point => point.value)).toEqual([10]);
  expect(model.snapshot.financials[0]![1].annualStatements.map(row => row.eps)).toEqual([10]);
  expect(model.snapshot.financials[0]![1].statementHistory?.status).toBe("available");
  expect(model.snapshot.historyVariants?.map(entry => entry.resolution).sort()).toEqual(["15m", "1d"]);
  const replay = await loadChartPaneModel(spec, { marketData: createSnapshotDataProvider(JSON.parse(JSON.stringify(model.snapshot)), createTestDataProvider()) } as HeadlessPaneContext);
  expect(replay.errors).toEqual([]);
  expect(replay.chart.series.map(series => ({ resolution: series.historyResolution, points: series.points })))
    .toEqual(model.chart.series.map(series => ({ resolution: series.historyResolution, points: series.points })));
  expect(replay.snapshot.historyVariants?.map(entry => entry.resolution).sort()).toEqual(["15m", "1d"]);
});
