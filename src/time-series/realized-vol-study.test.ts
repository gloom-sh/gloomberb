import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { buildPriceChartPreset, setBuiltinStudies } from "../plugins/builtin/chart-composer/presets";
import { realizedVolatility, REALIZED_VOLATILITY_ESTIMATORS } from "../plugins/builtin/shared/volatility/realized";
import type { PricePoint, Quote, TickerFinancials } from "../types/financials";
import { createSnapshotDataProvider } from "../market-data/snapshot-provider";
import { extractPriceSeries } from "./market";
import { normalizeChartSpec, validateChartSpec } from "./spec";
import { resolveChartSpecData } from "./resolve";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { maxStudyWarmupPoints, resolveStudies } from "./studies";
import type { ChartStudySpec, ResolvedSeries } from "./types";

function history(count = 90): PricePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 * Math.exp(0.001 * index + 0.025 * Math.sin(index));
    return { date: new Date(Date.UTC(2025, 0, index + 1)), close, open: close * 0.99, high: close * 1.02, low: close * 0.97 };
  });
}

const source = { kind: "security" as const, instrument: { symbol: "TEST", exchange: "NASDAQ" }, fieldId: "market.ohlcv" };
function input(prices = history()): ResolvedSeries {
  return {
    id: "price", label: "TEST", color: "#fff", unit: "USD/share", unitGroup: "price:USD",
    nativeFrequency: "daily", dataShape: "ohlcv", style: "line", transform: "raw", axis: "left",
    panelId: "main", interpolation: "none", observationKind: "market", points: extractPriceSeries(prices, source),
  };
}
function study(estimator = "close-to-close", window = 5): ChartStudySpec {
  return { id: "rv", kind: "realized-vol", inputSeriesIds: ["price"], parameters: { window, estimator }, panelId: "rv", axis: "auto" };
}

test("realized volatility persists named estimators and rejects invalid settings", () => {
  const spec = setBuiltinStudies(buildPriceChartPreset("TEST"), ["realized-vol"]);
  for (const estimator of REALIZED_VOLATILITY_ESTIMATORS) {
    spec.studies[0]!.parameters = { window: 60, estimator };
    const restored = normalizeChartSpec(JSON.parse(JSON.stringify(spec)));
    expect(restored.studies[0]!.parameters).toEqual({ window: 60, estimator });
    expect(validateChartSpec(restored).valid).toBe(true);
  }
  for (const parameters of [{ window: 1 }, { window: 2.5 }, { estimator: "unknown" }, { estimator: 2 }]) {
    const invalid = { ...spec, studies: [{ ...spec.studies[0]!, parameters }] };
    expect(validateChartSpec(normalizeChartSpec(invalid)).valid).toBe(false);
  }
});

test("all five studies use shared annualized math with their exact warmup", () => {
  const prices = history();
  for (const estimator of REALIZED_VOLATILITY_ESTIMATORS) {
    const spec = study(estimator);
    const warmup = estimator === "close-to-close" || estimator === "yang-zhang" ? 5 : 4;
    const result = resolveStudies([input(prices)], [spec], "1d");
    const output = result.series[0]!;
    expect(result.errors).toEqual([]);
    expect(output.unit).toBe("%");
    expect(maxStudyWarmupPoints([spec])).toBe(warmup);
    expect(output.points).toHaveLength(prices.length);
    expect(output.points.slice(0, warmup).every((point) => point.value === null)).toBe(true);
    expect(output.points[warmup]!.value).toBeCloseTo(realizedVolatility(prices.slice(0, warmup + 1), 5, estimator)! * 100, 10);
    expect(output.points.at(-1)!.value).toBeCloseTo(realizedVolatility(prices, 5, estimator)! * 100, 10);
  }
});

test("missing and contradictory bars interrupt windows until every rejected input rolls out", () => {
  for (const rejected of [
    { close: Number.NaN },
    { open: 1, high: 1, low: 2, close: 1 },
  ]) {
    const prices = history();
    prices[20] = { ...prices[20]!, ...rejected };
    const result = resolveStudies([input(prices)], [study()], "1d");
    const points = result.series[0]!.points;
    expect(points[19]!.value).not.toBeNull();
    expect(points.slice(20, 26).map((point) => point.value)).toEqual([null, null, null, null, null, null]);
    expect(points[26]!.value).toBeCloseTo(realizedVolatility(prices.slice(21, 27), 5)! * 100, 10);
    if (rejected.close === 1) {
      expect(points[25]!.provenance?.priceHistoryIntegrity?.sourcePoints[0]!.date).toBe(prices[20]!.date.toISOString());
      expect(points[26]!.provenance?.priceHistoryIntegrity).toBeUndefined();
    }
  }
});

test("range estimators preserve missing OHLC instead of substituting the close", () => {
  const prices = history().map(({ date, close }) => ({ date, close }));
  const daily = input(prices);
  daily.points = extractPriceSeries(prices, { ...source, period: "daily" });
  expect(resolveStudies([daily], [study()], "1d").series[0]!.points.at(-1)!.value).not.toBeNull();
  for (const estimator of REALIZED_VOLATILITY_ESTIMATORS.filter((value) => value !== "close-to-close")) {
    const result = resolveStudies([daily], [study(estimator)], "1d");
    expect(result.series[0]!.points.every((point) => point.value === null)).toBe(true);
    expect(result.warnings).toHaveLength(1);
  }
});

test("daily annualization rejects weekly, intraday, non-price and invalid parameter inputs", () => {
  for (const [series, resolution] of [
    [input(), "1h"], [input(), "1wk"],
    [{ ...input(), nativeFrequency: "weekly" }, "1d"],
    [{ ...input(), unitGroup: "revenue" }, "1d"],
    [{ ...input(), timeBasis: { kind: "market", timeZone: "UTC", cadenceMs: 3_600_000 } }, "1d"],
  ] as const) {
    const result = resolveStudies([series], [study()], resolution);
    expect(result.series).toEqual([]);
    expect(result.errors).toHaveLength(1);
  }
  for (const spec of [study("unknown"), study("close-to-close", 1), study("close-to-close", 2.5)]) {
    expect(resolveStudies([input()], [spec], "1d").errors).toHaveLength(1);
  }
});

test("auto charts fetch daily bars over long ranges and compute warmup before visible clipping", async () => {
  const prices = history(200);
  const requests: string[] = [];
  const provider = createTestDataProvider({
    getChartResolutionSupport: () => [{ resolution: "1d", maxRange: "ALL" }, { resolution: "1wk", maxRange: "ALL" }],
    getPriceHistoryForResolution: async (_symbol, _exchange, _range, resolution) => { requests.push(resolution); return prices; },
  });
  const base = setBuiltinStudies(buildPriceChartPreset("TEST"), ["realized-vol"]);
  base.viewport = { range: "ALL", resolution: "auto", dateWindow: { start: "2025-06-01", end: "2025-07-01" } };
  const sources = { dataProvider: provider, now: new Date("2025-07-02") };
  const result = await resolveChartSpecData(base, sources);
  expect(requests).toEqual(["1d"]);
  expect(result.errors).toEqual([]);
  const first = result.series.find((series) => series.id === base.studies[0]!.id)!.points[0]!;
  expect(first.date.toISOString().slice(0, 10)).toBe("2025-06-01");
  expect(first.value).toBeCloseTo(realizedVolatility(prices.filter((point) => point.date <= first.date), 30)! * 100, 10);
  const longRange = await resolveChartSpecData({ ...base, viewport: { range: "ALL", resolution: "auto" } }, sources);
  expect(longRange.resolution).toBe("1d");
  const manual = await resolveChartSpecData({ ...base, viewport: { ...base.viewport, resolution: "1wk" } }, sources);
  expect(manual.errors.some((error) => error.includes("requires daily prices"))).toBe(true);
  expect(manual.series.some((series) => series.id === base.studies[0]!.id)).toBe(false);
});

test("provider bars mislabeled as daily cannot annualize weekly or intraday returns", async () => {
  const base = setBuiltinStudies(buildPriceChartPreset("TEST"), ["realized-vol"]);
  base.viewport = { range: "ALL", resolution: "auto" };
  for (const step of [7 * 86_400_000, 3_600_000]) {
    const prices = history().map((point, index) => ({ ...point, date: new Date(Date.UTC(2025, 0, 1) + index * step) }));
    const provider = createTestDataProvider({
      getChartResolutionSupport: () => [{ resolution: "1d", maxRange: "ALL" }],
      getPriceHistoryForResolution: async () => prices,
    });
    const result = await resolveChartSpecData(base, { dataProvider: provider, now: new Date("2027-01-01") });
    expect(result.resolution).toBe("1d");
    expect(result.errors.some((error) => error.includes("Daily history unavailable"))).toBe(true);
    expect(result.series.some((series) => series.id === base.studies[0]!.id)).toBe(false);
  }
});

test("live quote append and same-day updates leave daily volatility unchanged, including snapshot replay", async () => {
  const prices = history();
  const last = prices.at(-1)!;
  const base = setBuiltinStudies(buildPriceChartPreset("TEST"), ["sma20", "realized-vol"]);
  base.viewport = { range: "1Y", resolution: "1d" };
  const series = base.series[0]!;
  if (series.source.kind !== "security") throw new Error("Expected price source");
  series.source.instrument.exchange = "NASDAQ";
  const quoteKey = chartQuoteOverrideKeyForSource(series.source);
  const provider = createTestDataProvider({ getPriceHistoryForResolution: async () => prices });
  for (const estimator of REALIZED_VOLATILITY_ESTIMATORS) {
    base.studies.find((study) => study.kind === "realized-vol")!.parameters = { window: 30, estimator };
    const expected = realizedVolatility(prices, 30, estimator)! * 100;
    for (const dayOffset of [0, 1]) {
      const now = new Date(last.date.getTime() + dayOffset * 86_400_000 + 14 * 3_600_000);
      const quote: Quote = { symbol: "TEST", price: last.close * 1.04, currency: "USD", instrumentType: "EQUITY",
        listingExchangeName: "NASDAQ", marketState: "REGULAR", lastUpdated: now.getTime(), change: 1, changePercent: 1 };
      let captured: TickerFinancials | null = null;
      const result = await resolveChartSpecData(base, { dataProvider: provider, now,
        quoteOverrides: new Map([[quoteKey, quote]]), onSecurityData: (_series, data) => { captured = data; } });
      expect(result.errors).toEqual([]);
      const rv = result.series.find((entry) => entry.id.includes("realized-vol"))!;
      expect(rv.points.at(-1)!.date).toEqual(last.date);
      expect(rv.points.at(-1)!.value).toBeCloseTo(expected, 10);
      expect(result.series.find((entry) => entry.id === series.id)!.points.at(-1)!.close).toBe(quote.price);
      const displayPrices = dayOffset ? [...prices.map((point) => point.close), quote.price]
        : [...prices.slice(0, -1).map((point) => point.close), quote.price];
      expect(result.series.find((entry) => entry.id.includes("sma20"))!.points.at(-1)!.value)
        .toBeCloseTo(displayPrices.slice(-20).reduce((total, price) => total + price, 0) / 20, 10);
      const snapshot = captured as TickerFinancials | null;
      expect(snapshot!.priceHistory).toEqual(prices);
      expect(snapshot!.quote!.price).toBe(quote.price);
      const replay = await resolveChartSpecData(base, { now, quoteOverrides: new Map([[quoteKey, snapshot!.quote!]]), dataProvider: createSnapshotDataProvider({
        financials: [["TEST:NASDAQ", snapshot!]], intradayHistories: [],
      }, provider) });
      expect(replay.series.find((entry) => entry.id.includes("realized-vol"))!.points.at(-1)!.value).toBeCloseTo(expected, 10);
      expect(replay.series.find((entry) => entry.id === series.id)!.points.at(-1)!.close).toBe(quote.price);
    }
  }
});
