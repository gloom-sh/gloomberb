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
const resolve = (instrumentType?: string, transform: SeriesTransform = "raw", chart = spec(transform)) => resolveChartSpecData(chart, {
  now: new Date("2026-09-11"),
  dataProvider: createTestDataProvider({
    getQuote: async () => ({ symbol: "SHIB-USD", listingExchangeName: "CCC", currency: "USD", instrumentType, price: 999, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") }),
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
  // A loading seed draws with what the last settled chart of the listing knew
  // (USD, no instrument type), never with a type read from the symbol's shape.
  const chart = spec();
  const seeded = seedChartResolutionResult(chart, new Map(chart.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), history])));
  expect(seeded?.series.map((entry) => entry.unit)).toEqual(Array(5).fill("USD"));
});

test("normalized crypto prices keep the original unit in raw-value provenance", async () => {
  const result = await resolve("CRYPTOCURRENCY", "index100");
  const close = result.series.find((entry) => entry.id === "close")!;
  expect(close.rawUnit).toBe("USD/unit");
  expect(close.unit).toBe("index");
  expect(close.points.map((point) => point.value)).toEqual([100, 120]);
  expect(close.points.map((point) => point.rawValue)).toEqual([0.000005, 0.000006]);
});

test("futures and unknown price bases stay available as raw prices but cannot establish a spread", async () => {
  for (const instrumentType of ["FUTURE", undefined]) {
    const chart = spec();
    chart.series = chart.series.slice(0, 2);
    chart.studies = ["ratio", "spread"].map((kind) => ({
      id: kind, kind: kind as "ratio" | "spread", inputSeriesIds: chart.series.map(({ id }) => id), color: "#fff",
      parameters: {}, panelId: "main", axis: "auto",
    }));
    const before = await resolve(instrumentType, "raw", { ...chart, studies: [chart.studies[0]!] });
    const result = await resolve(instrumentType, "raw", chart);
    expect(result.series.filter(({ id }) => id !== "spread")).toEqual(before.series);
    expect(result.series.some(({ id }) => id === "spread")).toBe(false);
    expect(result.series.find(({ id }) => id === "ratio")?.unit).toBe("unknown");
    expect(result.errors).toEqual([expect.stringContaining("spread cannot subtract")]);
  }
});
