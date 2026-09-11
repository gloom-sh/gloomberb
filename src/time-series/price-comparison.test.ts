import { describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import type { PricePoint, Quote } from "../types/financials";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { resolvePriceComparison } from "./price-comparison";
import { ChartResolveCache, resolveChartSpecData, seedChartResolutionResult } from "./resolve";
import { summarizeResolvedSeries } from "./reporting";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";

const date = (day: string) => new Date(day);
const rows = (values: [string, number][]): PricePoint[] => values.map(([day, close]) => ({ date: date(day), close }));
const spec = (resolution: "1d" | "1wk" = "1d"): ChartSpec => ({
  version: CHART_SPEC_VERSION,
  viewport: { range: "5Y", resolution, dateWindow: { start: "2021-01-01", end: "2026-09-10" } },
  panels: [{ id: "main" }], studies: [],
  series: ["OLDER", "NEWER"].map((symbol) => ({
    id: symbol, source: { kind: "security", instrument: { symbol, exchange: "NASDAQ" }, fieldId: "market.close" },
    style: "line", transform: "percent", axis: "left", panelId: "main", interpolation: "none",
  })),
});
const histories = {
  OLDER: rows([["2021-01-04", 100], ["2022-05-02", 80], ["2022-05-09", 90], ["2026-09-07", 180], ["2026-09-10", 200]]),
  NEWER: rows([["2022-05-02", 50], ["2022-05-09", 55], ["2026-09-07", 60]]),
};
function sources(history: Record<string, PricePoint[]> = histories) {
  const getHistory = async (symbol: string) => history[symbol] ?? [];
  return {
    now: date("2026-09-10T18:00:00Z"),
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, currency: "USD", instrumentType: "ETF", price: 999, change: 0, changePercent: 50, lastUpdated: Date.parse("2026-09-10T18:00:00Z") }),
      getTickerFinancials: async (symbol) => ({ annualStatements: [], quarterlyStatements: [], priceHistory: history[symbol] ?? [] }),
      getDetailedPriceHistory: getHistory,
      getPriceHistory: getHistory,
      getPriceHistoryForResolution: getHistory,
    }),
    loadFredSeries: async () => ({ data: { observations: [], info: null }, fetchedAt: 0, stale: false, source: "network" as const }),
  };
}

describe("normalized market price comparison", () => {
  for (const resolution of ["1d", "1wk"] as const) {
    test(`${resolution} uses shared inception and endpoint in chart, buffered rendering and raw report`, async () => {
      const result = await resolveChartSpecData(spec(resolution), sources());
      expect(result.priceComparison).toMatchObject({ start: Date.parse("2022-05-02"), end: Date.parse("2026-09-07") });
      for (const collection of [result.series, result.bufferedSeries!, result.legendSeries!]) {
        expect(collection.map((s) => s.points[0]?.value)).toEqual([0, 0]);
        expect(collection.map((s) => s.points.at(-1)?.value)).toEqual([125, 20]);
        expect(collection.map((s) => s.latestChangePercent)).toEqual([undefined, undefined]);
      }
      expect(summarizeResolvedSeries(result.series[0]!)).toMatchObject({
        startDate: "2022-05-02T00:00:00.000Z", endDate: "2026-09-07T00:00:00.000Z", startValue: 80, endValue: 180, return: 1.25,
      });
      expect(histories.OLDER[0]?.close).toBe(100);
      const seeded = seedChartResolutionResult(spec(resolution), new Map(spec().series.map((s) => [chartQuoteOverrideKeyForSource(s.source), histories[s.id as keyof typeof histories]])));
      expect(seeded?.series.map((s) => s.points.at(-1)?.value)).toEqual([125, 20]);
      expect(seeded?.priceComparison?.start).toBe(result.priceComparison?.start);
    });
  }

  test("missing holiday dates use an exact overlap without carrying or rounding observations", async () => {
    const result = await resolveChartSpecData(spec(), sources({
      OLDER: rows([["2026-09-04", 10], ["2026-09-07", 15], ["2026-09-08", 20], ["2026-09-09", 30], ["2026-09-10", 40]]),
      NEWER: rows([["2026-09-08", 100], ["2026-09-10", 300]]),
    }));
    expect(result.priceComparison).toMatchObject({ start: Date.parse("2026-09-08"), end: Date.parse("2026-09-10") });
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([100, 200]);
    expect(result.series.map((s) => s.points.length)).toEqual([3, 2]);
    const shifted = result.series.map((s, index) => ({ ...s, points: s.points.map((p) => ({ ...p, date: new Date(p.date.getTime() + index * 1_000) })) }));
    expect(resolvePriceComparison(spec(), shifted, { start: null, end: null }, "1m")?.start).toBeNull();
  });

  test("daily comparisons align market dates while preserving exact source timestamps and endpoints", async () => {
    const chart = spec();
    chart.series[0]!.source = { kind: "security", instrument: { symbol: "OLDER", exchange: "CCC" }, fieldId: "market.close" };
    const data = {
      OLDER: rows([["2026-09-07", 80], ["2026-09-08", 100], ["2026-09-09", 110], ["2026-09-10", 200]]),
      NEWER: rows([["2026-09-08T13:30:00Z", 50], ["2026-09-09T13:30:00Z", 60]]),
    };
    const result = await resolveChartSpecData(chart, sources(data));
    expect(result.priceComparison).toMatchObject({ alignment: "session-date", sourceBounds: {
      OLDER: { start: Date.parse("2026-09-08"), end: Date.parse("2026-09-09") },
      NEWER: { start: Date.parse("2026-09-08T13:30:00Z"), end: Date.parse("2026-09-09T13:30:00Z") },
    } });
    for (const collection of [result.series, result.bufferedSeries!, result.legendSeries!]) {
      expect(collection.map((entry) => entry.points.map((point) => point.value))).toEqual([[0, 10], [0, 20]]);
      expect(collection[0]!.points.at(-1)!.date.toISOString()).toBe("2026-09-09T00:00:00.000Z");
      expect(collection[1]!.points[0]!.date.toISOString()).toBe("2026-09-08T13:30:00.000Z");
    }
    expect(summarizeResolvedSeries(result.series[1]!)).toMatchObject({ startValue: 50, endValue: 60, return: 0.2 });
    const seeded = seedChartResolutionResult(chart, new Map(chart.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), data[entry.id as keyof typeof data]])));
    expect(seeded?.series.map((entry) => entry.points.at(-1)?.value)).toEqual([10, 20]);
    expect(data.OLDER.at(-1)?.close).toBe(200);
  });

  test("session dates handle venues opening on the preceding UTC day", async () => {
    const chart = spec();
    chart.series[1]!.source = { kind: "security", instrument: { symbol: "NEWER", exchange: "ASX" }, fieldId: "market.close" };
    const result = await resolveChartSpecData(chart, sources({
      OLDER: rows([["2026-01-08T14:30:00Z", 10], ["2026-01-09T14:30:00Z", 12]]),
      NEWER: rows([["2026-01-07T23:00:00Z", 20], ["2026-01-08T23:00:00Z", 30]]),
    }));
    expect(result.series.map((entry) => entry.points.at(-1)?.value)).toEqual([20, 50]);
    // In summer Sydney's opening bar starts on the previous UTC date.
    expect(result.priceComparison?.sourceBounds?.NEWER.start).toBe(Date.parse("2026-01-07T23:00:00Z"));
  });

  test("one-leg streamed and snapshot quotes cannot rewrite a shared weekly source bar", async () => {
    const compared = spec("1wk");
    const inputs = sources();
    const quote: Quote = { symbol: "NEWER", currency: "USD", price: 900, change: 0, changePercent: 99, lastUpdated: inputs.now.getTime(), marketState: "REGULAR" };
    inputs.dataProvider.getTickerFinancials = async (symbol) => ({ annualStatements: [], quarterlyStatements: [], priceHistory: histories[symbol as keyof typeof histories], quote });
    // Bare listings also load financials with a snapshot quote.
    for (const s of compared.series) if (s.source.kind === "security") delete s.source.instrument.exchange;
    const result = await resolveChartSpecData(compared, { ...inputs, quoteOverrides: new Map([[chartQuoteOverrideKeyForSource(compared.series[1]!.source), quote]]) });
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([125, 20]);
    expect(result.series.map((s) => s.points.at(-1)?.rawValue)).toEqual([180, 60]);
  });

  test("missing, disjoint and single-overlap history leave comparison unavailable, then recover from the source", async () => {
    for (const newer of [[], rows([["2026-09-10", 60]]), rows([["2025-01-02", 60], ["2025-01-03", 65]])]) {
      const result = await resolveChartSpecData(spec(), sources({ ...histories, NEWER: newer }));
      expect(result.priceComparison).toMatchObject({ start: null, end: null });
      expect(result.series.every((s) => s.points.length === 0)).toBe(true);
      expect(result.bufferedSeries?.every((s) => s.points.length === 0)).toBe(true);
    }
    const partialSeed = seedChartResolutionResult(spec(), new Map([[chartQuoteOverrideKeyForSource(spec().series[0]!.source), histories.OLDER]]));
    expect(partialSeed?.series[0]?.points).toEqual([]);
    const recovered = await resolveChartSpecData(spec(), sources());
    expect(recovered.series[0]?.points.at(-1)?.value).toBe(125);
  });

  test("a legitimate zero endpoint is -100%; a zero baseline is never divided", async () => {
    const result = await resolveChartSpecData(spec(), sources({
      OLDER: rows([["2026-09-07", 0], ["2026-09-08", 10], ["2026-09-10", 0]]),
      NEWER: rows([["2026-09-07", 50], ["2026-09-08", 100], ["2026-09-10", 200]]),
    }));
    expect(result.priceComparison?.start).toBe(Date.parse("2026-09-08"));
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([-100, 100]);
  });

  test("index100 shares dates while price studies still calculate from raw buffered observations", async () => {
    const indexed = spec();
    indexed.series.forEach((s) => { s.transform = "index100"; });
    indexed.studies = [
      { id: "sma", kind: "sma", inputSeriesIds: ["OLDER"], parameters: { period: 2 }, panelId: "main", axis: "left" },
      { id: "ratio", kind: "ratio", inputSeriesIds: ["OLDER", "NEWER"], parameters: {}, panelId: "ratio", axis: "left" },
    ];
    const result = await resolveChartSpecData(indexed, sources());
    expect(result.series.slice(0, 2).map((s) => s.points.at(-1)?.value)).toEqual([225, 120]);
    const sma = result.series.find((s) => s.id === "sma")!;
    const firstCommon = sma.points.find((p) => p.date.getTime() === Date.parse("2022-05-02"))!;
    expect(firstCommon.rawValue).toBe(90);
    expect(firstCommon.value).toBe(112.5);
    expect(result.series.find((s) => s.id === "ratio")?.points.at(-1)?.value).toBe(200 / 60);
  });

  test("explicit/panned windows recompute shared baselines while raw, mixed and period-limited charts retain their meaning", async () => {
    const selected = spec();
    selected.viewport.dateWindow!.start = "2022-05-09";
    const cache = new ChartResolveCache();
    const result = await resolveChartSpecData(selected, sources(), cache);
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([100, 100 / 11]);
    const panned = await resolveChartSpecData(selected, sources(), cache, { requestViewport: { start: date("2026-09-07"), end: date("2026-09-10") } });
    expect(panned.priceComparison?.start).toBeNull();
    const raw = spec();
    raw.series.forEach((s) => { s.transform = "raw"; });
    const rawResult = await resolveChartSpecData(raw, sources());
    expect(rawResult.priceComparison).toBeUndefined();
    expect(rawResult.series.map((s) => s.points[0]?.value)).toEqual([100, 50]);
    expect(rawResult.series.map((s) => s.points.at(-1)?.value)).toEqual([200, 60]);
    const mixed = spec();
    mixed.series[1]!.source = { kind: "economic", provider: "fred", seriesId: "GDP" };
    expect(resolvePriceComparison(mixed, rawResult.series, { start: null, end: null })).toBeNull();
    const limited = spec(); limited.viewport.maxPoints = 2;
    expect(resolvePriceComparison(limited, rawResult.series, { start: null, end: null })).toBeNull();
  });
});
