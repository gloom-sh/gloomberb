import { describe, expect, test } from "bun:test";
import {
  computeBeta,
  computeDatedBeta,
  computeDatedReturns,
  resolveDatedReturns,
  computeSectorAllocation,
  computeSharpeRatio,
  computeWeightedPortfolioReturns,
  type DatedReturn,
} from "./metrics";

function datedReturns(values: number[], startDay = 1): DatedReturn[] {
  return values.map((value, index) => ({
    dateKey: `2024-01-${String(startDay + index).padStart(2, "0")}`,
    value,
  }));
}

describe("computeSharpeRatio", () => {
  test("computes positive Sharpe for good returns", () => {
    const returns = Array.from({ length: 20 }, () => 0.005 + (Math.random() - 0.5) * 0.001);
    const sharpe = computeSharpeRatio(returns);
    expect(sharpe).not.toBeNull();
    expect(sharpe!).toBeGreaterThan(0);
  });

  test("returns null for insufficient data", () => {
    expect(computeSharpeRatio([0.01, 0.02])).toBeNull();
  });

  test("returns null for zero variance", () => {
    expect(computeSharpeRatio(Array(20).fill(0.01))).toBeNull();
  });
});

describe("computeBeta", () => {
  test("beta of 1 when returns match market", () => {
    const returns = Array.from({ length: 20 }, () => Math.random() * 0.02 - 0.01);
    const beta = computeBeta(returns, returns);
    expect(beta).toBeCloseTo(1.0, 1);
  });

  test("returns null for insufficient data", () => {
    expect(computeBeta([0.01], [0.01])).toBeNull();
  });

  test("aligns dated returns before computing beta", () => {
    const market = datedReturns([
      -0.010, 0.015, 0.004, -0.006, 0.011,
      0.008, -0.012, 0.009, 0.013, -0.007,
      0.005, 0.010,
    ], 2);
    const asset = [
      { dateKey: "2024-01-01", value: 0.25 },
      ...market.map((point) => ({ dateKey: point.dateKey, value: point.value * 2 })),
    ];

    expect(computeDatedBeta(asset, market)).toBeCloseTo(2, 5);
  });

  test("weights portfolio returns by holding value", () => {
    const market = datedReturns([
      -0.010, 0.015, 0.004, -0.006, 0.011,
      0.008, -0.012, 0.009, 0.013, -0.007,
      0.005, 0.010,
    ]);
    const portfolio = computeWeightedPortfolioReturns([
      {
        weight: 80,
        returns: market.map((point) => ({ dateKey: point.dateKey, value: point.value * 2 })),
      },
      {
        weight: 20,
        returns: market.map((point) => ({ dateKey: point.dateKey, value: 0 })),
      },
    ]);

    expect(computeDatedBeta(portfolio, market)).toBeCloseTo(1.6, 5);
  });

  test("computes dated returns from closing prices", () => {
    const returns = computeDatedReturns([
      { date: new Date("2024-01-01T00:00:00Z"), close: 100 },
      { date: new Date("2024-01-02T00:00:00Z"), close: 110 },
      { date: new Date("2024-01-03T00:00:00Z"), close: 99 },
    ]);

    expect(returns).toEqual([
      { dateKey: "2024-01-02", value: 0.1 },
      { dateKey: "2024-01-03", value: -0.1 },
    ]);
  });

  test("quarantines contradictory samples and permits a corrected duplicate to recover", () => {
    const start = { date: new Date("2026-09-08"), close: 100 };
    const bad = { date: new Date("2026-09-09"), open: 105, high: 102, low: 99, close: 101 };
    const end = { date: new Date("2026-09-10"), close: 110 };
    const input = [start, bad, end];
    const rejected = resolveDatedReturns(input);
    expect(computeDatedReturns(input)).toEqual([]);
    expect(rejected.integrity?.sourcePoints[0]).toMatchObject({ date: "2026-09-09T00:00:00.000Z", open: 105, high: 102 });
    const recovered = resolveDatedReturns([...input, { ...bad, high: 106 }]);
    expect(recovered.integrity).toBeNull();
    expect(recovered.returns.map((entry) => entry.value)).toEqual([0.01, 9 / 101]);
    expect(bad.high).toBe(102);
    expect(rejected.integrity?.sourcePoints[0]?.high).toBe(102);
  });
});

describe("computeSectorAllocation", () => {
  test("computes weights from positions", () => {
    const alloc = computeSectorAllocation([
      { sector: "Technology", marketValue: 60000 },
      { sector: "Healthcare", marketValue: 40000 },
    ]);
    expect(alloc).toHaveLength(2);
    expect(alloc[0]!.sector).toBe("Technology");
    expect(alloc[0]!.weight).toBeCloseTo(0.6, 2);
  });

  test("groups same sectors", () => {
    const alloc = computeSectorAllocation([
      { sector: "Tech", marketValue: 30000 },
      { sector: "Tech", marketValue: 20000 },
      { sector: "Health", marketValue: 50000 },
    ]);
    expect(alloc).toHaveLength(2);
    expect(alloc[0]!.sector).toBe("Health");
    expect(alloc[0]!.weight).toBeCloseTo(0.5, 2);
  });

  test("uses Unknown for missing sector", () => {
    const alloc = computeSectorAllocation([{ sector: "", marketValue: 100 }]);
    expect(alloc[0]!.sector).toBe("Unknown");
  });
});
