import { expect, test } from "bun:test";
import { extractPriceSeries, marketSeriesFrequency } from "./market";
import { resolveStudies } from "./studies";
import type { ChartStudySpec, ResolvedSeries, SecuritySeriesSource } from "./types";

const source: SecuritySeriesSource = { kind: "security", instrument: { symbol: "BTC-USD", exchange: "CCC" }, fieldId: "market.ohlcv" };
const prices = Array.from({ length: 35 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)),
  open: 100 + i, high: 102 + i, low: 99 + i, close: 100 + i + Math.sin(i), volume: 10 + i }));
const input = (historyResolution: ResolvedSeries["historyResolution"]): ResolvedSeries => ({
  id: "price", label: "BTC", color: "#fff", unit: "USD/unit", unitGroup: "price:USD", dataShape: "ohlcv", style: "line", transform: "raw",
  axis: "left", panelId: "main", interpolation: "none", observationKind: "market", historyResolution,
  nativeFrequency: marketSeriesFrequency(source, historyResolution), points: extractPriceSeries(prices, source),
});
const rv: ChartStudySpec = { id: "rv", kind: "realized-vol", inputSeriesIds: ["price"], parameters: { window: 5 }, panelId: "rv", axis: "auto" };

test("unknown daily-looking bars remain usable observations but cannot establish annualized daily volatility", () => {
  const opaque = input(null);
  // Field/default or caller metadata cannot promote an opaque acquisition.
  opaque.nativeFrequency = "daily";
  const specs: ChartStudySpec[] = [rv,
    { id: "sma", kind: "sma", inputSeriesIds: ["price"], parameters: { period: 3 }, panelId: "main", axis: "auto" },
    { id: "volume", kind: "volume", inputSeriesIds: ["price"], parameters: {}, panelId: "volume", axis: "auto" }];
  const result = resolveStudies([opaque], specs, "1d");
  expect(result.errors).toEqual([expect.stringContaining("realized volatility requires daily prices")]);
  expect(result.series.map(series => series.id)).toEqual(["sma", "volume"]);
  expect(result.series.every(series => series.historyResolution === null)).toBe(true);
  expect(result.series[0]!.points.at(-1)!.value).toBeCloseTo(prices.slice(-3).reduce((sum, point) => sum + point.close, 0) / 3, 10);
  expect(result.series[1]!.points.map(point => point.value)).toEqual(prices.map(point => point.volume));
  expect(input(null).nativeFrequency).toBe("auto");
});

test("proved daily inputs use their own cadence within a mixed chart while old standalone series retain compatibility", () => {
  const known = resolveStudies([input("1d")], [rv], "15m");
  const legacy = resolveStudies([input(undefined)], [rv], "1d");
  expect(known.errors).toEqual([]);
  expect(known.series[0]!.points).toEqual(legacy.series[0]!.points);
  expect(known.series[0]!.historyResolution).toBe("1d");
  expect(resolveStudies([input(null)], [rv]).series).toEqual([]);
  expect(resolveStudies([input("1wk")], [rv], "1d").series).toEqual([]);
});

test("pair studies cannot inherit one leg's known cadence when the other leg differs or is unknown", () => {
  for (const other of ["15m", null] as const) {
    const left = { ...input("1d"), timeBasis: { kind: "market" as const, timeZone: "UTC", cadenceMs: 86_400_000 } };
    const right = { ...input(other), id: "other" };
    const result = resolveStudies([left, right], [{ id: "ratio", kind: "ratio", inputSeriesIds: ["price", "other"], parameters: {}, panelId: "main", axis: "auto" }]);
    expect(result.errors).toEqual([]);
    expect(result.series[0]!.points.every(point => point.value === 1)).toBe(true);
    expect(result.series[0]!.historyResolution).toBeNull();
    expect(result.series[0]!.timeBasis?.cadenceMs).toBeUndefined();
  }
});
