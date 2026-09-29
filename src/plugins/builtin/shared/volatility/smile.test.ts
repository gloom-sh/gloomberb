import { describe, expect, test } from "bun:test";
import { valueOption } from "./pricing";
import {
  detectButterflyArbitrage, detectCalendarArbitrage, evaluateSmile,
  fitVolatilitySmile, interpolateTotalVariance, sviTotalVariance,
  type SmilePoint, type SviParameters,
} from "./smile";

const parameters: SviParameters = { a: 0.012, b: 0.08, rho: -0.55, m: 0.03, sigma: 0.12 };
const years = 0.5;
const knownSmile: SmilePoint[] = Array.from({ length: 17 }, (_, index) => {
  const logMoneyness = -0.4 + index * 0.05;
  return { logMoneyness, volatility: Math.sqrt(sviTotalVariance(parameters, logMoneyness) / years) };
});

describe("smile fitting", () => {
  test("recovers a known skewed raw SVI smile and off-grid total variance", () => {
    const original = structuredClone(knownSmile);
    const fit = fitVolatilitySmile(knownSmile, years)!;
    expect(fit.method).toBe("svi");
    expect(fit.fallbackReason).toBeNull();
    expect(fit.residual).toBeLessThan(1e-7);
    for (const name of ["a", "b", "rho", "m", "sigma"] as const) {
      expect(fit.parameters![name]).toBeCloseTo(parameters[name], 5);
    }
    for (const k of [-0.31, -0.015, 0.137, 0.29]) {
      expect(evaluateSmile(fit, k)! ** 2 * years).toBeCloseTo(sviTotalVariance(parameters, k), 8);
    }
    expect(knownSmile).toEqual(original);
  });

  test("accepts valid negative a and positive skew without imposing arbitrage repair", () => {
    const model: SviParameters = { a: -0.01, b: 0.2, rho: 0.4, m: -0.06, sigma: 0.15 };
    const points = knownSmile.map(({ logMoneyness }) => ({
      logMoneyness, volatility: Math.sqrt(sviTotalVariance(model, logMoneyness) / years),
    }));
    const fit = fitVolatilitySmile(points, years)!;
    expect(fit.method).toBe("svi");
    expect(fit.parameters!.a).toBeLessThan(0);
    expect(fit.parameters!.rho).toBeGreaterThan(0);
    expect(fit.residual).toBeLessThan(1e-7);
  });

  test("falls back on an exhausted optimizer or unacceptable SVI residual", () => {
    const limited = fitVolatilitySmile(knownSmile, years, { maxIterations: 1 })!;
    expect(limited.method).toBe("monotone-cubic");
    expect(limited.fallbackReason).toContain("converge");
    const jagged = knownSmile.map((point, index) => ({ ...point, volatility: point.volatility + (index % 2 ? 0.1 : 0) }));
    const fit = fitVolatilitySmile(jagged, years, { maxResidual: 0.001 })!;
    expect(fit.method).toBe("monotone-cubic");
    expect(fit.fallbackReason).not.toBeNull();
    expect(fit.residual).toBeLessThan(1e-12);
    for (const point of jagged) expect(evaluateSmile(fit, point.logMoneyness)).toBeCloseTo(point.volatility, 12);
  });

  test("cubic fallback preserves monotonic intervals and extrema on uneven knots", () => {
    const points = [
      { logMoneyness: -0.6, volatility: 0.8 },
      { logMoneyness: -0.02, volatility: 0.19 },
      { logMoneyness: 0, volatility: 0.2 },
      { logMoneyness: 0.8, volatility: 0.23 },
    ];
    const fit = fitVolatilitySmile(points, 0.1)!;
    expect(fit.method).toBe("monotone-cubic");
    for (let index = 1; index < points.length; index += 1) {
      const left = points[index - 1]!;
      const right = points[index]!;
      let previous = left.volatility;
      for (let step = 1; step <= 100; step += 1) {
        const iv = evaluateSmile(fit, left.logMoneyness + (right.logMoneyness - left.logMoneyness) * step / 100)!;
        expect(iv).toBeGreaterThanOrEqual(Math.min(left.volatility, right.volatility) - 1e-12);
        expect(iv).toBeLessThanOrEqual(Math.max(left.volatility, right.volatility) + 1e-12);
        expect((iv - previous) * Math.sign(right.volatility - left.volatility)).toBeGreaterThanOrEqual(-1e-12);
        previous = iv;
      }
    }
    expect(evaluateSmile(fit, -3)).toBe(0.8);
    expect(evaluateSmile(fit, 3)).toBe(0.23);
  });

  test("rejects unusable data, reports dropped quotes and consolidates duplicate knots", () => {
    expect(fitVolatilitySmile(knownSmile, 0)).toBeNull();
    expect(fitVolatilitySmile(knownSmile, NaN)).toBeNull();
    expect(fitVolatilitySmile([{ logMoneyness: 0, volatility: 0.2 }], years)).toBeNull();
    const fit = fitVolatilitySmile([
      { logMoneyness: 0.1, volatility: 0.4 },
      { logMoneyness: 0, volatility: 0.2 },
      { logMoneyness: 0, volatility: 0.4 },
      { logMoneyness: NaN, volatility: 0.2 },
      { logMoneyness: 0.2, volatility: -0.1 },
      { logMoneyness: 0.3, volatility: Infinity },
    ], years)!;
    expect(fit.droppedPoints).toBe(3);
    expect(fit.points).toHaveLength(2);
    expect(evaluateSmile(fit, 0)).toBeCloseTo(Math.sqrt(0.1), 12);
    expect(fit.residual).toBeGreaterThan(0);
    expect(evaluateSmile(fit, NaN)).toBeNull();
    const zero = fitVolatilitySmile([{ logMoneyness: 0, volatility: 0 }, { logMoneyness: 1, volatility: 0 }], years)!;
    expect(evaluateSmile(zero, 0.5)).toBe(0);
  });

  test("rejects finite quotes whose total variance or cubic slopes overflow", () => {
    const overflow = [{ logMoneyness: 0, volatility: 1e200 }, { logMoneyness: 1, volatility: 1e200 }];
    expect(fitVolatilitySmile(overflow, years)).toBeNull();
    const mixed = fitVolatilitySmile([...knownSmile, ...overflow], years)!;
    expect(mixed.droppedPoints).toBe(2);
    expect(mixed.residual).toBeFinite();
    expect(fitVolatilitySmile([{ logMoneyness: 0, volatility: 1e154 }, { logMoneyness: 1e-8, volatility: 1e150 }], 1)).toBeNull();
    expect(interpolateTotalVariance([{ years: 1, volatility: 1e200 }], 1)).toBeNull();
    expect(interpolateTotalVariance([{ years: 1, volatility: 1e154 }], 10)).toBeNull();
  });
});

describe("total variance interpolation", () => {
  const tenors = [{ years: 0.25, volatility: 0.4 }, { years: 1, volatility: 0.2 }];

  test("interpolates total variance rather than volatility and preserves exact tenors", () => {
    const original = structuredClone(tenors);
    const mid = interpolateTotalVariance(tenors.toReversed(), 0.5)!;
    expect(mid.totalVariance).toBeCloseTo(0.04, 12);
    expect(mid.volatility).toBeCloseTo(Math.sqrt(0.08), 12);
    expect(mid.interpolated).toBe(true);
    expect(mid.extrapolated).toBe(false);
    expect(mid.sourceYears).toEqual([0.25, 1]);
    expect(interpolateTotalVariance(tenors, 0.25)).toEqual({
      years: 0.25, volatility: 0.4, totalVariance: 0.4 ** 2 * 0.25,
      interpolated: false, extrapolated: false, sourceYears: [0.25, 0.25],
    });
    expect(tenors).toEqual(original);
  });

  test("uses explicitly marked flat IV extrapolation including expiry and a single tenor", () => {
    for (const target of [0, 0.1, 1.5]) {
      const result = interpolateTotalVariance(tenors, target)!;
      const expectedVolatility = target < 0.25 ? 0.4 : 0.2;
      expect(result.extrapolated).toBe(true);
      expect(result.interpolated).toBe(false);
      expect(result.volatility).toBe(expectedVolatility);
      expect(result.totalVariance).toBeCloseTo(expectedVolatility ** 2 * target, 12);
    }
    expect(interpolateTotalVariance([tenors[0]!], 0.5)!.volatility).toBe(0.4);
    expect(interpolateTotalVariance([], 1)).toBeNull();
    expect(interpolateTotalVariance(tenors, -1)).toBeNull();
    expect(interpolateTotalVariance(tenors, Infinity)).toBeNull();
    expect(interpolateTotalVariance([{ years: NaN, volatility: 0.2 }], 1)).toBeNull();
    expect(interpolateTotalVariance([{ years: 1, volatility: 0.2 }, { years: 1, volatility: 0.3 }], 1)).toBeNull();
    expect(interpolateTotalVariance([{ years: 1, volatility: 0.2 }, { years: 1, volatility: 0.2 }], 2)!.volatility).toBe(0.2);
  });
});

describe("arbitrage warnings", () => {
  test("warns on decreasing variance, not decreasing IV, and never repairs calendar inputs", () => {
    const valid = [{ years: 0.25, volatility: 0.4 }, { years: 1, volatility: 0.3 }];
    expect(detectCalendarArbitrage(valid)).toEqual([]);
    const bad = [{ years: 1, volatility: 0.1 }, { years: 0.25, volatility: 0.4 }];
    const before = structuredClone(bad);
    expect(detectCalendarArbitrage(bad)).toEqual([{
      kind: "calendar", earlierYears: 0.25, laterYears: 1,
      earlierVariance: 0.4 ** 2 * 0.25, laterVariance: 0.1 ** 2,
    }]);
    expect(bad).toEqual(before);
    expect(interpolateTotalVariance(bad, 0.5)!.totalVariance).toBeCloseTo(0.03, 12);
  });

  test("uses convex strike slopes on irregular spacing without false flags on Black-Scholes calls", () => {
    const strikes = [50, 80, 90, 95, 100, 102, 110, 130, 170];
    const valid = strikes.map((strike) => ({ strike, callPrice: valueOption({
      side: "call", spot: 100, strike, daysToExpiry: 180, rate: 0.04, volatility: 0.25, dividendYield: 0.01,
    }).price }));
    expect(detectButterflyArbitrage(valid.toReversed())).toEqual([]);
    const irregular = [{ strike: 90, callPrice: 12 }, { strike: 100, callPrice: 7 }, { strike: 120, callPrice: 2 }];
    expect(detectButterflyArbitrage(irregular)).toEqual([]);
    const bad = [{ strike: 90, callPrice: 12 }, { strike: 100, callPrice: 11 }, { strike: 120, callPrice: 2 }];
    const original = structuredClone(bad);
    expect(detectButterflyArbitrage(bad)).toEqual([{
      kind: "butterfly", strikes: [90, 100, 120], leftSlope: -0.1, rightSlope: -0.45,
    }]);
    expect(bad).toEqual(original);
    expect(detectButterflyArbitrage(bad.slice(0, 2))).toEqual([]);
  });

  test("duplicate tenors cannot conceal a decreasing-variance pair", () => {
    const points = [
      { years: 0.25, volatility: 0.4 },
      { years: 0.25, volatility: 0.1 },
      { years: 1, volatility: 0.15 },
    ];
    const original = structuredClone(points);
    const warnings = detectCalendarArbitrage(points);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.earlierVariance).toBeCloseTo(0.04, 12);
    expect(warnings[0]!.laterVariance).toBeCloseTo(0.0225, 12);
    expect(detectCalendarArbitrage(points.toReversed())).toEqual(warnings);
    expect(detectCalendarArbitrage(points.flatMap((point) => [point, point]))).toEqual(warnings);
    expect(points).toEqual(original);
  });

  test("identical or conflicting duplicate strikes cannot conceal concavity", () => {
    const points = [{ strike: 90, callPrice: 12 }, { strike: 100, callPrice: 11 }, { strike: 120, callPrice: 2 }];
    const warnings = detectButterflyArbitrage(points);
    expect(detectButterflyArbitrage([points[0]!, points[1]!, points[1]!, points[2]!])).toEqual(warnings);
    const conflicting = [...points, { strike: 100, callPrice: 7 }, { strike: 90, callPrice: 13 }];
    const original = structuredClone(conflicting);
    expect(detectButterflyArbitrage(conflicting)).toEqual(warnings);
    expect(detectButterflyArbitrage(conflicting.toReversed())).toEqual(warnings);
    expect(conflicting).toEqual(original);
  });
});
