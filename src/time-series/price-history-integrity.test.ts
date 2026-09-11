import { expect, test } from "bun:test";
import type { PricePoint } from "../types/financials";
import type { HeadlessPaneContext } from "../types/headless";
import { createTestDataProvider } from "../test-support/data-provider";
import { pricePointIntegrity, pricePointValues } from "../utils/price-history-integrity";
import { historicalPricesHeadless } from "../plugins/builtin/ticker-detail/headless";
import { loadChartPaneModel } from "../plugins/builtin/chart-composer/headless";
import { extractPriceSeries } from "./market";
import { appendLiveQuotePoint } from "./chart-data";
import { seedChartResolutionResult } from "./resolve";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { resolveStudies } from "./studies";
import { buildPriceReturnFields } from "../market-data/performance";
import { pricePointsToResolvedSeries } from "../components/chart/composite/price-series";
import { applyCompositeChartCursor, buildCompositeChartScene } from "../components/chart/composite/scene";
import { CHART_SPEC_VERSION, type ChartSpec, type ResolvedSeries, type SeriesPeriod, type SeriesTransform } from "./types";

// Actual SPY row retained from the September 10 Yahoo history cache. The open
// exceeds the reported high; a later close does not tell us which field is wrong.
const reported: PricePoint = {
  date: new Date("2026-09-10T13:30:00.000Z"),
  open: 764.0800170898438, high: 758.5549926757812, low: 757.5700073242188,
  close: 758.1500244140625, volume: 3461376,
};
const history: PricePoint[] = [
  { date: new Date("2026-09-09T13:30:00Z"), close: 757 }, reported,
  { date: new Date("2026-09-11T13:30:00Z"), close: 760 },
  { date: new Date("2026-09-14T13:30:00Z"), close: 761 },
];
const source = { kind: "security" as const, instrument: { symbol: "SPY", exchange: "ARCX" }, fieldId: "market.ohlcv" };
function spec(transform: SeriesTransform = "raw"): ChartSpec {
  return {
    version: CHART_SPEC_VERSION,
    viewport: { range: "1M", resolution: "1d", dateWindow: { start: "2026-09-08", end: "2026-09-15" } },
    panels: [{ id: "main" }], studies: [],
    series: [{ id: "price", source, style: "candles", transform, axis: "left", panelId: "main", interpolation: "none" }],
  };
}
function resolved(points: PricePoint[] = history): ResolvedSeries {
  return {
    ...spec().series[0]!, id: "price", label: "SPY", color: "#ffffff", unit: "USD/share", unitGroup: "price:USD",
    nativeFrequency: "daily", dataShape: "ohlcv", axis: "left", timeBasis: { kind: "market", timeZone: "America/New_York" }, points: extractPriceSeries(points, source),
  };
}

test("the invariant detects contradictions without inventing missing OHLC or losing tiny and negative valid prices", () => {
  for (const point of [reported, { ...reported, open: undefined, high: 1, low: 2 }, { ...reported, open: undefined, high: 800, low: 759 }]) {
    const checked = pricePointValues(point);
    expect(checked).toMatchObject({ open: null, high: null, low: null, close: null, volume: null });
    expect(checked.integrity?.reason).toBe("inconsistent-ohlc");
    expect(checked.integrity?.sourcePoints[0]).toEqual({ ...point, date: point.date.toISOString() });
    expect(Object.isFrozen(checked.integrity?.sourcePoints[0])).toBe(true);
  }
  for (const point of [
    { date: reported.date, close: 758 },
    { date: reported.date, open: -2, high: 0, low: -3, close: -1 },
    { date: reported.date, open: 0.00000002, high: 0.00000003, low: 0.00000001, close: 0.000000025 },
    { date: reported.date, high: 0.3, close: 0.1 + 0.2 },
  ]) expect(pricePointIntegrity(point)).toBeUndefined();
  expect(pricePointIntegrity({ date: reported.date, high: 0.00000001, close: 0.00000002 })).toBeDefined();
  const copy = { ...reported };
  const diagnostic = pricePointIntegrity(copy)!;
  copy.open = 1;
  expect(diagnostic.sourcePoints[0]!.open).toBe(reported.open);
  const withSource: PricePoint = { ...reported, historySource: { provider: "yahoo", symbol: "SHEL", exchange: "LSE", currency: "GBP" } };
  const sourceDiagnostic = pricePointIntegrity(withSource)!;
  withSource.historySource!.provider = "twelvedata";
  expect(sourceDiagnostic.sourcePoints[0]!.historySource?.provider).toBe("yahoo");
  expect(Object.isFrozen(sourceDiagnostic.sourcePoints[0]!.historySource)).toBe(true);
});

test("every price field and aggregated window retain an explicit gap and original source diagnostics", () => {
  for (const period of ["auto", "daily", "weekly", "monthly", "quarterly", "annual"] as SeriesPeriod[]) {
    for (const field of ["ohlcv", "open", "high", "low", "close", "volume"]) {
      const points = extractPriceSeries(history, { ...source, fieldId: `market.${field}`, period });
      const gap = points.find((point) => point.provenance?.priceHistoryIntegrity)!;
      expect(gap).toMatchObject({ value: null, open: null, high: null, low: null, close: null, volume: null });
      expect(gap.provenance!.priceHistoryIntegrity!.sourcePoints).toEqual([{ ...reported, date: reported.date.toISOString() }]);
      expect(points.every((point) => point.value !== reported.close)).toBe(true);
    }
  }
  const nonFiniteClose = extractPriceSeries([{ ...reported, close: NaN }], source);
  expect(nonFiniteClose).toHaveLength(1);
  expect(nonFiniteClose[0]!.value).toBeNull();
  const merged = extractPriceSeries([reported, { ...reported, date: new Date("2026-09-11") }], { ...source, period: "weekly" })[0]!.provenance!.priceHistoryIntegrity!;
  expect(merged.sourcePoints).toHaveLength(2);
  expect(Object.isFrozen(merged)).toBe(true);
  expect(Object.isFrozen(merged.sourcePoints)).toBe(true);
});

test("seed, resolved chart transforms and HP exports agree on quarantined values and visible notices", async () => {
  const context = {
    marketData: createTestDataProvider({ getPriceHistory: async () => history, getPriceHistoryForResolution: async () => history }),
  } as HeadlessPaneContext;
  const hp = await historicalPricesHeadless.load({ symbols: ["SPY:ARCX"], options: { range: "ALL" }, argument: ["SPY:ARCX"], rawArgument: "SPY:ARCX" }, context);
  expect(hp.rows[1]).toMatchObject({ date: reported.date.toISOString(), close: null, open: null, integrity: pricePointIntegrity(reported) });
  expect(hp.metadata!.notices).toHaveLength(1);
  expect(hp.complete).toBe(false);
  const seeded = seedChartResolutionResult(spec(), new Map([[chartQuoteOverrideKeyForSource(source), history]]))!;
  expect(seeded.warnings.join(" ")).toContain("inconsistent OHLC");
  for (const transform of ["raw", "percent", "index100", "log", "yoy", "qoq"] as SeriesTransform[]) {
    const model = await loadChartPaneModel(spec(transform), context);
    expect(model.chart.errors).toEqual([]);
    expect(model.complete).toBe(false);
    const json = JSON.parse(JSON.stringify(model));
    const gap = json.series[0].points.find((point: { provenance?: { priceHistoryIntegrity?: unknown } }) => point.provenance?.priceHistoryIntegrity);
    expect(gap).toMatchObject({ value: null, open: null, high: null, low: null, close: null });
    expect(gap.provenance.priceHistoryIntegrity.sourcePoints[0].open).toBe(reported.open);
    expect(json.metadata.notices.join(" ")).toContain("inconsistent OHLC");
    expect(json.metadata.summaries[0]).toMatchObject({ return: null, startValue: null, endValue: null });
  }
});

test("a fresh quote cannot silently repair an inconsistent reported bar", () => {
  const now = Date.parse("2026-09-10T15:00:00Z");
  const result = appendLiveQuotePoint([reported], {
    symbol: "SPY", currency: "USD", price: 766, change: 8, changePercent: 1, lastUpdated: now, marketState: "REGULAR",
  }, { now, mode: "ohlc", resolution: "1d", exchange: "ARCX" });
  expect(result[0]).toEqual(reported);
  expect(extractPriceSeries(result, source)[0]!.value).toBeNull();
});

test("overview chart and return windows preserve the integrity boundary without suppressing unaffected horizons", () => {
  const chart = pricePointsToResolvedSeries(history, { id: "overview", label: "SPY", color: "#fff", unit: "USD" });
  expect(chart.points[1]).toMatchObject({ value: null, open: null, close: null });
  expect(chart.warning).toContain("inconsistent OHLC");
  const fields = buildPriceReturnFields([
    { date: new Date("2025-10-09"), close: 700 }, reported,
    { date: new Date("2026-09-11"), close: 760 }, { date: new Date("2026-10-11"), close: 770 },
  ]);
  expect(fields.find((field) => field.id === "1M")!.value).toBeCloseTo(10 / 760);
  expect(fields.find((field) => field.id === "1Y")).toMatchObject({ value: null, unavailableReason: "inconsistent-ohlc" });
  expect(buildPriceReturnFields([reported]).every((field) => field.unavailableReason === "inconsistent-ohlc")).toBe(true);
});

test("chart cursor and latest-price marker cannot carry a prior close across a rejected bar", () => {
  const latestBad = resolved(history.slice(0, 2));
  const options = { width: 100, height: 20 };
  const scene = buildCompositeChartScene([latestBad], [{ id: "main" }], options)!;
  expect(scene.endTime).toBe(reported.date.getTime());
  expect(scene.panels[0]!.lastPrice).toBeUndefined();
  expect(scene.cursorValues[0]!.value).toBeNull();
  const hovered = applyCompositeChartCursor(scene, reported.date);
  expect(hovered.cursorValues[0]!.point?.provenance?.priceHistoryIntegrity).toBeDefined();
  expect(hovered.cursorValues[0]!.value).toBeNull();
  expect(applyCompositeChartCursor(scene, history[0]!.date).cursorValues[0]!.value).toBe(757);
  const recovered = buildCompositeChartScene([resolved()], [{ id: "main" }], options)!;
  expect(recovered.cursorValues[0]!.value).toBe(761);
  expect(recovered.panels[0]!.lastPrice?.value).toBe(761);
  expect(applyCompositeChartCursor(recovered, reported.date).cursorValues[0]!.value).toBeNull();
});

test("rolling and recursive studies restart after a corrupt row instead of calculating around it", () => {
  const input = resolved();
  for (const kind of ["sma", "ema", "bollinger", "rsi", "macd"] as const) {
    const result = resolveStudies([input], [{ id: kind, kind, inputSeriesIds: [input.id], parameters: { period: 2, fast: 1, slow: 2, signal: 1 }, panelId: "main", axis: "left" }]);
    for (const output of result.series) {
      expect(output.points.find((point) => point.date.getTime() === reported.date.getTime())?.value).toBeNull();
      expect(output.points.some((point) => point.date.getTime() === history[2]!.date.getTime() && point.value !== null)).toBe(false);
      const warmup = output.points.find((point) => point.date.getTime() === history[2]!.date.getTime());
      expect(warmup?.provenance?.priceHistoryIntegrity?.sourcePoints[0]?.date).toBe(reported.date.toISOString());
    }
    if (kind === "sma" || kind === "ema") expect(result.series[0]!.points.at(-1)?.value).toBe(760.5);
  }
});

test("a study retains integrity attribution while warming up after a gap outside the visible window", async () => {
  const chart = spec();
  chart.viewport.dateWindow = { start: "2026-09-11", end: "2026-09-15" };
  chart.studies = [{ id: "sma", kind: "sma", inputSeriesIds: ["price"], parameters: { period: 2 }, panelId: "main", axis: "left" }];
  const model = await loadChartPaneModel(chart, {
    marketData: createTestDataProvider({ getPriceHistory: async () => history, getPriceHistoryForResolution: async () => history }),
  } as HeadlessPaneContext);
  const study = model.series.find((entry) => entry.id === "sma")!;
  expect(study.points[0]).toMatchObject({ date: history[2]!.date, value: null });
  expect(study.points[0]!.provenance?.priceHistoryIntegrity?.sourcePoints[0]?.date).toBe(reported.date.toISOString());
  expect(study.points[1]).toMatchObject({ value: 760.5 });
  expect(study.points[1]!.provenance?.priceHistoryIntegrity).toBeUndefined();
  expect(model.complete).toBe(false);
  expect(model.chart.warnings.some((warning) => warning.startsWith("SMA") && warning.includes("inconsistent OHLC"))).toBe(true);
  expect(model.chart.priceHistoryIntegrity?.map((entry) => [entry.seriesId, entry.scope])).toEqual([["sma", "visible-calculation"]]);
});

test("pair studies keep the corrupt observation as a gap and retain valid peer levels on recovery", () => {
  const input = resolved();
  const peer = { ...resolved([{ date: history[0]!.date, close: 10 }]), id: "peer", label: "Peer" };
  for (const kind of ["ratio", "spread"] as const) {
    const output = resolveStudies([input, peer], [{ id: kind, kind, inputSeriesIds: [input.id, peer.id], parameters: {}, panelId: "main", axis: "left" }]).series[0]!;
    expect(output.points.map((point) => point.value)).toEqual(kind === "ratio" ? [75.7, null, 76, 76.1] : [747, null, 750, 751]);
  }
  const constantPeer = { ...peer, points: resolved(history.map((point) => ({ date: point.date, close: 10 }))).points };
  const correlation = resolveStudies([input, constantPeer], [{ id: "corr", kind: "correlation", inputSeriesIds: [input.id, peer.id], parameters: { period: 2, returns: 0 }, panelId: "main", axis: "left" }]).series[0]!;
  expect(correlation.points.at(-1)?.value).toBeNull(); // Zero variance after enough valid observations.
  expect(correlation.points.at(-1)?.provenance?.priceHistoryIntegrity).toBeUndefined();
});
