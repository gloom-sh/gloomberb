import { describe, expect, test } from "bun:test";
import {
  computeReturns,
  correlateDailyCloses,
  dailyCloses,
  pearsonCorrelation,
} from "./compute";

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

describe("computeReturns", () => {
  test("computes simple returns", () => {
    const returns = computeReturns([100, 110, 105, 115]);
    expect(returns).toHaveLength(3);
    expect(returns[0]).toBeCloseTo(0.1, 5);
    expect(returns[1]).toBeCloseTo(-0.0455, 3);
    expect(returns[2]).toBeCloseTo(0.0952, 3);
  });

  test("skips zero or invalid previous closes", () => {
    expect(computeReturns([0, 10, 20, Number.NaN, 30])).toEqual([1]);
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
