import { describe, expect, test } from "bun:test";
import {
  correlateDailyCloses,
  dailyCloses,
  dailyValues,
  pearsonCorrelation,
} from "./compute";
import { geoSeriesToken } from "./geo";

describe("cross-market return alignment", () => {
  test("uses matching return intervals across weekends, exchange holidays, and missing sessions", () => {
    const history = (dates: string[], closes: number[]) => dates.map((date, i) => ({ date: new Date(date), close: closes[i]! }));
    const equity = history(
      ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-09", "2026-01-12"],
      [100, 110, 105, 115, 111, 118],
    );
    const crypto = [...history(
      ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-09", "2026-01-12"],
      [200, 220, 210, 230, 222, 236],
    ), ...history(["2026-01-04", "2026-01-08", "2026-01-11"], [250, 190, 270])];

    // Both assets have identical moves between shared closes. Weekend-only
    // prices must not change the intervals used for either side.
    expect(correlateDailyCloses(dailyCloses(equity), dailyCloses(crypto))).toEqual({ correlation: 1, sampleSize: 5 });
    expect(correlateDailyCloses(dailyCloses(crypto), dailyCloses(equity))).toEqual({ correlation: 1, sampleSize: 5 });
  });

  test("uses the final valid observation for a date without inventing intraday daily returns", () => {
    expect(dailyCloses([
      { date: new Date("2026-01-03T22:00:00Z"), close: 121 },
      { date: new Date("2026-01-02T20:00:00Z"), close: 105 },
      { date: new Date("2026-01-01"), close: 100 },
      { date: new Date("2026-01-02T22:00:00Z"), close: 110 },
      { date: new Date("2026-01-02T23:00:00Z"), close: Number.NaN },
    ])).toEqual([
      { dateKey: "2026-01-01", close: 100 },
      { dateKey: "2026-01-02", close: 110 },
      { dateKey: "2026-01-03", close: 121 },
    ]);
  });
});

describe("map series in the matrix", () => {
  test("pairs a daily count's level change with stock returns over the same shared dates, keeping zero counts", () => {
    const weekdays = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12"];
    const stock = dailyCloses(weekdays.map((date, i) => ({
      date: new Date(date), close: [100, 110, 99, 118.8, 112.86, 124.146, 99.3168][i]!,
    })));
    // Level changes between weekdays are 100x the stock's returns (+10%, -10%, +20%, -5%, +10%, -20%).
    // Weekend counts must not enter either interval, and zero is a count, not a gap.
    const transits = dailyValues([
      ...weekdays.map((date, i) => ({ date: new Date(date), value: [0, 10, 0, 20, 15, 25, 5][i]! })),
      ...["2026-01-03", "2026-01-04", "2026-01-10", "2026-01-11"].map((date, i) => ({ date: new Date(date), value: [40, 0, 3, 60][i]! })),
      { date: new Date("2026-01-13"), value: null },
    ]);
    const result = correlateDailyCloses(stock, transits, 5, "return", "difference");
    expect(result.sampleSize).toBe(6);
    expect(result.correlation).toBeCloseTo(1, 10);
    // A return basis would divide by the zero counts and lose those intervals.
    expect(correlateDailyCloses(stock, transits, 5, "return", "return").sampleSize).toBe(4);
  });

  test("reads GEO entries as map series and leaves tickers alone", () => {
    expect(geoSeriesToken("GEO:HORMUZ")).toBe("HORMUZ");
    expect(geoSeriesToken(" geo:suez.tanker ")).toBe("suez.tanker");
    for (const entry of ["GEO", "GEO:", "FRO", "BRK.B", "SHEL:LSE", "FRED:DGS10"]) expect(geoSeriesToken(entry)).toBeNull();
  });
});

describe("pearsonCorrelation", () => {
  test("perfect positive correlation", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1.0, 5);
  });

  test("perfect negative correlation", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1.0, 5);
  });

  test("returns null for insufficient data", () => {
    expect(pearsonCorrelation([1, 2], [3, 4])).toBeNull();
  });

  test("returns null for zero variance", () => {
    expect(pearsonCorrelation([5, 5, 5, 5, 5], [1, 2, 3, 4, 5])).toBeNull();
  });

  test("keeps nearly constant return series finite and correlations bounded", () => {
    const x = [1, 2, 3, 4, 5].map((value) => 0.001 + value * 1e-12);
    expect(pearsonCorrelation(x, x)).toBeCloseTo(1);
    expect(pearsonCorrelation(x, x.map((value) => -value))).toBeCloseTo(-1);
    expect(pearsonCorrelation(x, [1, 2, Number.NaN, 4, 5])).toBeNull();
  });
});

test("matrix calculations clip buffered history and retain loading/error provenance without removing usable pairs", async () => {
  const { getSeriesForEntry, buildStatusSummary } = await import("./matrix/model");
  const { createIdleEntry } = await import("../../../market-data/result-types");
  const prices = [100, 110, 105, 112, 104, 115, 120].map((close, i) => ({ date: new Date(Date.UTC(2026, 8, i + 1)), close }));
  const buffered = [{ date: new Date("2025-01-01"), close: 2 }, ...prices];
  const entry = { ...createIdleEntry<typeof buffered>(), data: buffered, lastGoodData: buffered, fetchedAt: 123, phase: "refreshing" as const };
  const series = getSeriesForEntry("SPY", entry, "1M");
  expect(series).toMatchObject({ status: "ready", loading: true, observationCount: 6, fetchedAt: 123 });
  expect(buildStatusSummary(["SPY"], new Map([["SPY", series]]), 6, 6)).toContain("Loading: SPY");
  const retained = getSeriesForEntry("SPY", { ...entry, phase: "error", error: { reasonCode: "TIMEOUT", message: "Provider timed out" } }, "1M");
  expect(retained).toMatchObject({ status: "ready", loading: false, refreshError: "Provider timed out", fetchedAt: 123 });
  expect(retained.prices).toEqual(series.prices);
});
