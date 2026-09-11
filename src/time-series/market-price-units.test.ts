import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { resolveChartSpecData, seedChartResolutionResult } from "./resolve";
import { summarizeResolvedSeries } from "./reporting";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { CHART_SPEC_VERSION, type ChartSpec, type SeriesTransform } from "./types";

const history = [
  { date: new Date("2026-09-09"), open: 0.000004, high: 0.000006, low: 0.000003, close: 0.000005, volume: 100 },
  { date: new Date("2026-09-10"), open: 0.000005, high: 0.000007, low: 0.000004, close: 0.000006, volume: 120 },
];
const spec = (transform: SeriesTransform = "raw"): ChartSpec => ({
  version: CHART_SPEC_VERSION, viewport: { range: "1M", resolution: "1d" }, panels: [{ id: "main" }], studies: [],
  series: ["ohlcv", "open", "high", "low", "close"].map((field) => ({
    id: field, source: { kind: "security", instrument: { symbol: "SHIB-USD", exchange: "CCC" }, fieldId: `market.${field}` },
    style: field === "ohlcv" ? "candles" : "line", transform, axis: "left", panelId: "main", interpolation: "none",
  })),
});
const resolve = (instrumentType?: string, transform: SeriesTransform = "raw") => resolveChartSpecData(spec(transform), {
  now: new Date("2026-09-11"),
  dataProvider: createTestDataProvider({
    getQuote: async () => ({ symbol: "SHIB-USD", currency: "USD", instrumentType, price: 999, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") }),
    getPriceHistory: async () => history,
    getPriceHistoryForResolution: async () => history,
  }),
});

test("crypto price units use source type across OHLCV and scalar fields without inferring volume or changing prices", async () => {
  for (const type of ["CRYPTOCURRENCY", "Digital Currency"]) {
    const result = await resolve(type);
    expect(result.errors).toEqual([]);
    expect(result.series.map((entry) => entry.unit)).toEqual(Array(5).fill("USD/unit"));
    expect(result.series.map((entry) => summarizeResolvedSeries(entry).unit)).toEqual(Array(5).fill("USD/unit"));
    expect(result.series.every((entry) => entry.unitGroup === "price:USD" && entry.volumeUnit === undefined)).toBe(true);
    expect(result.series.find((entry) => entry.id === "close")?.points.map((point) => point.value)).toEqual([0.000005, 0.000006]);
  }
});

test("share denominations require equity metadata; crypto-shaped symbols cannot establish instrument type", async () => {
  for (const type of ["EQUITY", "ETF"]) {
    expect((await resolve(type)).series.map((entry) => entry.unit)).toEqual(Array(5).fill("USD/share"));
  }
  for (const type of [undefined, "", "FUTURE", "CURRENCY"]) {
    expect((await resolve(type)).series.map((entry) => entry.unit)).toEqual(Array(5).fill("USD"));
  }
  const chart = spec();
  const seeded = seedChartResolutionResult(chart, new Map(chart.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), history])));
  expect(seeded?.series.map((entry) => entry.unit)).toEqual(Array(5).fill("currency"));
});

test("normalized crypto prices keep the original unit in raw-value provenance", async () => {
  const result = await resolve("CRYPTOCURRENCY", "index100");
  const close = result.series.find((entry) => entry.id === "close")!;
  expect(close.rawUnit).toBe("USD/unit");
  expect(close.unit).toBe("index");
  expect(close.points.map((point) => point.value)).toEqual([100, 120]);
  expect(close.points.map((point) => point.rawValue)).toEqual([0.000005, 0.000006]);
});
