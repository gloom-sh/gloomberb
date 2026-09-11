import { expect, test } from "bun:test";
import type { PricePoint } from "../types/financials";
import type { HeadlessPaneContext } from "../types/headless";
import { createTestDataProvider } from "../test-support/data-provider";
import { loadChartPaneModel } from "../plugins/builtin/chart-composer/headless";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { ChartResolveCache, resolveChartSpecData, seedChartResolutionResult } from "./resolve";

const row = (date: string, close = 10, bad = false): PricePoint => ({
  date: new Date(date), close, ...(bad ? { open: 30, high: 20, low: 5 } : {}),
});
function chart(start = "2026-09-08", end = "2026-09-10"): ChartSpec {
  return {
    version: CHART_SPEC_VERSION,
    viewport: { range: "1M", resolution: "1d", dateWindow: { start, end } },
    panels: [{ id: "main" }], studies: [],
    series: ["A", "B"].map((symbol) => ({
      id: symbol, source: { kind: "security", instrument: { symbol, exchange: "NASDAQ" }, fieldId: "market.close" },
      style: "line", transform: "percent", axis: "left", panelId: "main", interpolation: "none",
    })),
  };
}
function provider(histories: Record<string, PricePoint[]>) {
  const getHistory = async (symbol: string) => histories[symbol] ?? [];
  return createTestDataProvider({
    getQuote: async (symbol) => ({ symbol, currency: "USD", instrumentType: "ETF", price: 12, change: 0, changePercent: 0, lastUpdated: 0 }),
    getPriceHistory: getHistory, getPriceHistoryForResolution: getHistory, getDetailedPriceHistory: getHistory,
  });
}

test("rejected requested comparison endpoints remain exported and incomplete while valid shared returns survive", async () => {
  for (const edge of [0, 2]) {
    const spec = chart();
    const histories = {
      A: [8, 9, 10].map((day, index) => row(`2026-09-${String(day).padStart(2, "0")}`, 10 + index, index === edge)),
      B: [8, 9, 10].map((day, index) => row(`2026-09-${String(day).padStart(2, "0")}`, 10 + index)),
    };
    const model = await loadChartPaneModel(spec, { marketData: provider(histories) } as HeadlessPaneContext);
    const seed = seedChartResolutionResult(spec, new Map(spec.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), histories[entry.id as "A" | "B"]])))!;
    expect(model.complete).toBe(false);
    expect(model.chart.priceHistoryIntegrity).toEqual(seed.priceHistoryIntegrity);
    expect(model.metadata!.priceHistoryIntegrity).toEqual(model.chart.priceHistoryIntegrity);
    for (const result of [model.chart, seed]) {
      expect(result.priceHistoryIntegrity).toHaveLength(1);
      expect(result.priceHistoryIntegrity![0]).toMatchObject({ seriesId: "A", scope: "requested-observation" });
      expect(result.priceHistoryIntegrity![0]!.integrity.sourcePoints).toEqual([{ ...histories.A[edge], date: histories.A[edge]!.date.toISOString() }]);
      expect(result.series.every((entry) => entry.points.length === 2 && entry.points.every((point) => !point.provenance?.priceHistoryIntegrity))).toBe(true);
      expect(result.series.every((entry) => entry.points[0]!.value === 0)).toBe(true);
      expect(result.priceComparison?.start).toBe(Date.parse(edge === 0 ? "2026-09-09" : "2026-09-08"));
      expect(result.priceComparison?.end).toBe(Date.parse(edge === 0 ? "2026-09-10" : "2026-09-09"));
      expect(result.warnings.some((warning) => warning.includes("inconsistent OHLC"))).toBe(true);
    }
    expect((model.metadata!.summaries as Array<{ return: number | null }>).every((summary) => summary.return !== null)).toBe(true);
    expect((model.metadata!.notices as string[]).some((notice) => notice.includes("inconsistent OHLC"))).toBe(true);
  }
});

test("integrity metadata excludes unrelated corruption in the loaded navigation buffer", async () => {
  const spec = chart();
  const histories = {
    A: [row("2026-09-07", 10, true), row("2026-09-08", 10), row("2026-09-09", 11), row("2026-09-10", 12), row("2026-09-11", 12, true)],
    B: [row("2026-09-08", 10), row("2026-09-09", 11), row("2026-09-10", 12)],
  };
  const model = await loadChartPaneModel(spec, { marketData: provider(histories) } as HeadlessPaneContext);
  expect(model.complete).not.toBe(false);
  expect(model.chart.priceHistoryIntegrity).toBeUndefined();
  expect(model.metadata!.priceHistoryIntegrity).toBeUndefined();
  expect(model.chart.warnings.some((warning) => warning.includes("inconsistent OHLC"))).toBe(false);
});

test("date-only integrity selection uses local market sessions while explicit and panned timestamps stay exact", async () => {
  const spec = chart("2026-01-08", "2026-01-10");
  spec.series[0]!.source = { kind: "security", instrument: { symbol: "A", exchange: "ASX" }, fieldId: "market.close" };
  const histories = {
    A: [row("2026-01-06T23:00:00Z", 10, true), row("2026-01-07T23:00:00Z", 10, true), row("2026-01-08T23:00:00Z", 11), row("2026-01-09T23:00:00Z", 12), row("2026-01-11T23:00:00Z", 12, true)],
    B: [row("2026-01-08T14:30:00Z", 10), row("2026-01-09T14:30:00Z", 11), row("2026-01-10T14:30:00Z", 12)],
  };
  const sources = { dataProvider: provider(histories) };
  const selected = await resolveChartSpecData(spec, sources);
  const seed = seedChartResolutionResult(spec, new Map(spec.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), histories[entry.id as "A" | "B"]])))!;
  for (const result of [selected, seed]) {
    expect(result.priceHistoryIntegrity?.flatMap((entry) => entry.integrity.sourcePoints.map((point) => point.date))).toEqual(["2026-01-07T23:00:00.000Z"]);
    expect(result.priceComparison?.sourceBounds?.A.start).toBe(Date.parse("2026-01-08T23:00:00Z"));
  }
  const exact = { start: new Date("2026-01-08T00:00:00Z"), end: new Date("2026-01-10T23:59:59.999Z") };
  const panned = await resolveChartSpecData(spec, sources, new ChartResolveCache(), { requestViewport: exact });
  expect(panned.priceHistoryIntegrity).toBeUndefined();
  expect(panned.warnings.some((warning) => warning.includes("inconsistent OHLC"))).toBe(false);
  spec.viewport.dateWindow = { start: exact.start.toISOString(), end: exact.end.toISOString() };
  expect((await resolveChartSpecData(spec, sources)).priceHistoryIntegrity).toBeUndefined();
});

test("a comparison with no usable overlap still preserves rejected selected rows", async () => {
  const spec = chart();
  const histories = { A: [row("2026-09-08", 10, true), row("2026-09-09", 11)], B: [row("2026-09-08", 10), row("2026-09-09", 11)] };
  const model = await loadChartPaneModel(spec, { marketData: provider(histories) } as HeadlessPaneContext);
  expect(model.chart.priceComparison?.start).toBeNull();
  expect(model.series.every((entry) => entry.points.length === 0)).toBe(true);
  expect(model.chart.priceHistoryIntegrity![0]!.integrity.sourcePoints[0]!.open).toBe(30);
  expect(model.complete).toBe(false);
});

test("observation-count windows exclude older corrupt rows while retaining a rejected selected row", async () => {
  const spec = chart();
  spec.viewport = { range: "ALL", resolution: "1d", maxPoints: 2 };
  const histories = {
    A: [row("2026-09-07", 10, true), row("2026-09-08", 10), row("2026-09-09", 11), row("2026-09-10", 12)],
    B: [row("2026-09-08", 10), row("2026-09-09", 11), row("2026-09-10", 12)],
  };
  const model = await loadChartPaneModel(spec, { marketData: provider(histories) } as HeadlessPaneContext);
  const seeded = seedChartResolutionResult(spec, new Map(spec.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), histories[entry.id as "A" | "B"]])))!;
  expect(model.complete).not.toBe(false);
  for (const result of [model.chart, seeded]) {
    expect(result.series.every((entry) => entry.points.length === 2)).toBe(true);
    expect(result.priceHistoryIntegrity).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("inconsistent OHLC"))).toBe(false);
  }
  histories.A[3] = row("2026-09-10", 12, true);
  const rejected = await loadChartPaneModel(spec, { marketData: provider(histories) } as HeadlessPaneContext);
  expect(rejected.complete).toBe(false);
  expect(rejected.chart.priceHistoryIntegrity?.every((entry) => entry.integrity.sourcePoints.every((point) => point.date === "2026-09-10T00:00:00.000Z"))).toBe(true);
});

test("a hidden source used only to retain the chart timeline does not report unrelated integrity warnings", async () => {
  const spec = chart();
  spec.series[0]!.visible = false;
  const histories = {
    A: [row("2026-09-08", 10, true), row("2026-09-09", 11), row("2026-09-10", 12)],
    B: [row("2026-09-08", 10), row("2026-09-09", 11), row("2026-09-10", 12)],
  };
  const model = await loadChartPaneModel(spec, { marketData: provider(histories) } as HeadlessPaneContext);
  expect(model.chart.timelineSeries?.[0]?.points.some((point) => point.provenance?.priceHistoryIntegrity)).toBe(true);
  expect(model.chart.priceHistoryIntegrity).toBeUndefined();
  expect(model.complete).not.toBe(false);
  expect(model.chart.warnings.some((warning) => warning.includes("inconsistent OHLC"))).toBe(false);
});
