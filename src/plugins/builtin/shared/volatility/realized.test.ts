import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../../types/financials";
import {
  realizedVolatility,
  realizedVolatilityCadenceIssue,
  realizedVolatilityResult,
  rollingRealizedVolatility,
  volatilityCone,
  type RealizedVolatilityEstimator,
} from "./realized";

function history(returns: readonly number[]): PricePoint[] {
  const points: PricePoint[] = [{ date: new Date(Date.UTC(2025, 0, 1)), close: 100 }];
  for (const [index, value] of returns.entries()) {
    points.push({ date: new Date(Date.UTC(2025, 0, index + 2)), close: points.at(-1)!.close * Math.exp(value) });
  }
  return points;
}

function rangeHistory(length: number): PricePoint[] {
  return Array.from({ length }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)),
    open: 100,
    high: 100 * Math.exp(0.03),
    low: 100 * Math.exp(-0.02),
    close: 100 * Math.exp(0.01),
  }));
}

describe("realized volatility estimators", () => {
  test("close-to-close uses n centered returns and sample variance", () => {
    // Mean log return 0.02, sample variance 0.0006.
    const points = history([0.01, -0.01, 0.04, 0.04]);
    expect(realizedVolatility(points, 4)).toBeCloseTo(Math.sqrt(0.0006 * 252), 12);
    expect(realizedVolatility(points.slice(1), 4)).toBeNull();
    expect(realizedVolatility(points, 2)).toBeCloseTo(0, 12);
    expect(realizedVolatility(history([0.02, 0.02, 0.02]), 3)).toBeCloseTo(0, 12);
    for (const window of [0, 1, -3, 2.5, NaN, Infinity]) {
      expect(realizedVolatilityResult(points, window).reason).toBe("invalid-window");
    }
  });

  test("range estimates agree with analytic log-OHLC examples and require n bars", () => {
    const points = rangeHistory(3);
    expect(realizedVolatility(points, 3, "parkinson")).toBeCloseTo(Math.sqrt(252 * 0.05 ** 2 / (4 * Math.LN2)), 12);
    expect(realizedVolatility(points, 3, "garman-klass")).toBeCloseTo(Math.sqrt(252 * (0.5 * 0.05 ** 2 - (2 * Math.LN2 - 1) * 0.01 ** 2)), 12);
    expect(realizedVolatility(points, 3, "rogers-satchell")).toBeCloseTo(Math.sqrt(252 * 0.0012), 12);
    expect(realizedVolatility(points, 3, "close-to-close")).toBeNull();
    for (const estimator of ["parkinson", "garman-klass", "rogers-satchell"] as const) {
      expect(realizedVolatility(points.slice(1), 3, estimator)).toBeNull();
    }
  });

  test("Yang-Zhang combines centered overnight and intraday variance with Rogers-Satchell", () => {
    const points: PricePoint[] = [{ date: new Date(Date.UTC(2025, 0, 1)), close: 100 }];
    const overnight = [0.01, -0.02, 0.015];
    const intraday = [0.02, -0.01, 0.005];
    for (let index = 0; index < 3; index += 1) {
      const open = points.at(-1)!.close * Math.exp(overnight[index]!);
      const close = open * Math.exp(intraday[index]!);
      points.push({
        date: new Date(Date.UTC(2025, 0, index + 2)), open, close,
        high: Math.max(open, close) * Math.exp(0.012),
        low: Math.min(open, close) * Math.exp(-0.013),
      });
    }
    const weight = 0.34 / 3.34;
    // Overnight sample variance = 0.000358333..., intraday = 0.000225.
    // Daily RS = 0.000813, 0.000563, 0.000438.
    const expected = Math.sqrt(252 * (0.0003583333333333333 + weight * 0.000225 + (1 - weight) * (0.000813 + 0.000563 + 0.000438) / 3));
    expect(realizedVolatility(points, 3, "yang-zhang")).toBeCloseTo(expected, 12);
    expect(realizedVolatility(points.slice(1), 3, "yang-zhang")).toBeNull();
  });

  test("Yang-Zhang sees opening jumps that intraday range estimators cannot see", () => {
    const points = history([0.1, -0.1, 0.1, -0.1]).map((point) => ({ ...point, open: point.close, high: point.close, low: point.close }));
    expect(realizedVolatility(points, 4, "yang-zhang")).toBeCloseTo(realizedVolatility(points, 4)!, 12);
    expect(realizedVolatility(points, 4, "yang-zhang")).toBeGreaterThan(1);
    for (const estimator of ["parkinson", "garman-klass", "rogers-satchell"] as const) {
      expect(realizedVolatility(points, 4, estimator)).toBe(0);
    }
  });
});

describe("history integrity and rolling windows", () => {
  test("daily cadence guard recognizes corrected chronology and rejects contradictory fallback bars", () => {
    const daily = rangeHistory(10);
    expect(realizedVolatilityCadenceIssue([...daily, daily[4]!].reverse())).toBeNull();
    const weekly = daily.map((point, index) => ({ ...point, date: new Date(Date.UTC(2025, 0, 1 + index * 7)) }));
    expect(realizedVolatilityCadenceIssue(weekly)).toContain("weekly");
    expect(realizedVolatilityCadenceIssue([...daily, { date: new Date(Date.UTC(2025, 0, 1, 14)) }])).toContain("intraday");
    expect(realizedVolatilityCadenceIssue([...daily, { date: new Date(NaN) }])).toContain("invalid history date");
    // One holiday gap in otherwise daily observations does not imply weekly data.
    expect(realizedVolatilityCadenceIssue([...daily, { date: new Date(Date.UTC(2025, 0, 15)) }])).toBeNull();
  });

  test("preserves invalid observations as gaps and recovers after they leave the window", () => {
    const points = history([0.01, -0.01, 0.02, -0.02, 0.01, -0.01]);
    const broken = { ...points[2]!, high: 80, low: 120 };
    points[2] = broken;
    const result = realizedVolatilityResult(points.slice(0, 5), 2);
    expect(result.reason).toBe("inconsistent-ohlc");
    expect(result.integrity!.sourcePoints[0]!.high).toBe(80);
    broken.high = 90;
    expect(result.integrity!.sourcePoints[0]!.high).toBe(80);
    expect(Object.isFrozen(result.integrity!.sourcePoints[0])).toBe(true);
    const series = rollingRealizedVolatility(points, { windows: [2] });
    expect(series.map((point) => point.values[2] === null)).toEqual([true, true, true, true, true, false, false]);
    expect(series.at(-1)!.values[2]).toBeCloseTo(realizedVolatility(points.slice(-3), 2)!, 12);
  });

  test("does not substitute older observations for invalid closes or incomplete OHLC", () => {
    const points = rangeHistory(4);
    for (const close of [0, -1, NaN, Infinity]) {
      expect(realizedVolatility([...points, { ...points[3]!, close }], 2)).toBeNull();
    }
    const closeOnly = points.map(({ date, close }) => ({ date, close }));
    expect(realizedVolatility(closeOnly, 2)).toBe(0);
    for (const estimator of ["parkinson", "garman-klass", "rogers-satchell", "yang-zhang"] as const) {
      expect(realizedVolatilityResult(closeOnly, 2, estimator).reason).toBe("missing-ohlc");
    }
    const noOpen = points.map((point) => ({ ...point, open: undefined }));
    expect(realizedVolatility(noOpen, 3, "parkinson")).toBeGreaterThan(0);
    expect(realizedVolatility(noOpen, 3, "garman-klass")).toBeNull();
  });

  test("deduplicates persisted corrections and sorts before choosing observations", () => {
    const good = history([0.01, -0.02, 0.03, -0.04]);
    const broken = { ...good[2]!, close: 0 };
    const corrected = [broken, ...good].map((point) => ({ ...point, date: point.date.toISOString() as unknown as Date }));
    expect(realizedVolatility(corrected, 4)).toBeCloseTo(realizedVolatility(good, 4)!, 12);
    expect(realizedVolatility([...good].reverse(), 4)).toBeCloseTo(realizedVolatility(good, 4)!, 12);
    expect(realizedVolatility([...good, broken], 4)).toBeNull();
    expect(realizedVolatility(good.slice(1).flatMap((point) => [point, point]), 4)).toBeNull();
    expect(realizedVolatilityResult([...good, { date: new Date(NaN), close: 100 }], 4).reason).toBe("invalid-date");
  });

  test("retains finite extreme prices without overflowing ratios", () => {
    const points = history([0, 0, 0, 0]).map((point, index) => ({ ...point, close: index % 2 ? 1e300 : 1e-300 }));
    expect(realizedVolatility(points, 4)).toBeFinite();
    const flat = points.map((point) => ({ ...point, close: 1e300, open: 1e300, high: 1e300, low: 1e300 }));
    for (const estimator of ["close-to-close", "parkinson", "garman-klass", "rogers-satchell", "yang-zhang"] satisfies RealizedVolatilityEstimator[]) {
      expect(realizedVolatility(flat, 4, estimator)).toBe(0);
    }
    const wideRange = flat.map((point) => ({ ...point, high: 1e300, low: 1e-300, close: 100, open: 100 }));
    for (const estimator of ["parkinson", "garman-klass", "rogers-satchell", "yang-zhang"] as const) {
      expect(realizedVolatility(wideRange, 4, estimator)).toBeFinite();
      expect(realizedVolatility(wideRange, 4, estimator)).toBeGreaterThan(0);
    }
  });

  test("computes each requested window without consuming duplicate sessions", () => {
    const points = history(Array.from({ length: 270 }, (_, index) => 0.01 * Math.sin(index)));
    const series = rollingRealizedVolatility(points);
    expect(series[259]!.values[260]).toBeNull();
    for (const window of [10, 20, 30, 60, 90, 180, 260]) {
      expect(series.at(-1)!.values[window]).toBeCloseTo(realizedVolatility(points, window)!, 12);
    }
  });
});

describe("volatility cone", () => {
  test("computes rank and distribution from rolling estimates, with midpoint ties", () => {
    const points = history([0.01, -0.01, 0.02, -0.02, 0.03]);
    const stats = volatilityCone(points, { windows: [2] })[0]!;
    const factor = Math.sqrt(126);
    // Two-return sample standard deviations equal |r2-r1| / sqrt(2).
    expect(stats.sampleSize).toBe(4);
    expect(stats.min).toBeCloseTo(0.02 * factor, 12);
    expect(stats.max).toBeCloseTo(0.05 * factor, 12);
    expect(stats.mean).toBeCloseTo(0.035 * factor, 12);
    expect(stats.median).toBeCloseTo(0.035 * factor, 12);
    expect(stats.current).toBeCloseTo(0.05 * factor, 12);
    expect(stats.percentile).toBe(87.5);
    expect(volatilityCone(history([0, 0, 0, 0]), { windows: [2] })[0]!.percentile).toBe(50);
  });

  test("uses calendar lookbacks, preserves warmup, and does not backfill a missing current", () => {
    const points = history(Array.from({ length: 800 }, () => 0));
    const oneYear = volatilityCone(points, { windows: [260], lookbackYears: 1 })[0]!;
    const twoYears = volatilityCone(points, { windows: [260], lookbackYears: 2 })[0]!;
    expect(oneYear.sampleSize).toBe(365);
    expect(twoYears.sampleSize).toBe(541);
    points.at(-1)!.close = 0;
    const missing = volatilityCone(points, { windows: [260] })[0]!;
    expect(missing.current).toBeNull();
    expect(missing.percentile).toBeNull();
    expect(missing.mean).toBe(0);
    expect(missing.sampleSize).toBe(364);
    const empty = volatilityCone([], { windows: [30] })[0]!;
    expect(empty.sampleSize).toBe(0);
    expect(empty.mean).toBeNull();
    expect(empty.percentile).toBeNull();
  });

  test("a leap-day lookback keeps March 1 from the prior year", () => {
    const dates = ["2023-02-27", "2023-02-28", "2023-03-01", "2024-02-29"];
    const points = rangeHistory(4).map((point, index) => ({ ...point, date: new Date(dates[index]!) }));
    expect(volatilityCone(points, { windows: [2], estimator: "parkinson", lookbackYears: 1 })[0]!.sampleSize).toBe(2);
  });
});
