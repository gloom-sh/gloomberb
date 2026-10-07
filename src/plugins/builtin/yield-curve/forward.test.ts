import { describe, expect, test } from "bun:test";
import { bootstrapDiscountFactors, discountFactor, forwardCurve } from "./forward";

const node = (years: number, value: number) => ({ id: years < 1 ? `${years * 12}M` : `${years}Y`, years, yield: value });

describe("one-year forward curve", () => {
  test("a flat par curve prices the same curve a year out", () => {
    const flat = [0.5, 1, 2, 5, 10, 30].map((years) => node(years, 4));
    const forward = forwardCurve(flat, "par", 2);
    // Only tenors whose end stays inside the curve: 30Y would need 31 years.
    expect(forward.map((point) => point.id)).toEqual(["6M", "1Y", "2Y", "5Y", "10Y"]);
    for (const point of forward) expect(point.yield).toBeCloseTo(4, 9);
  });

  test("bootstrapped factors reprice each par bond, and the 1y1y rate follows from them", () => {
    const curve = [node(1, 3), node(2, 4)];
    const factors = bootstrapDiscountFactors(curve, 1);
    const one = 1 / 1.03;
    const two = (1 - 0.04 * one) / 1.04;
    expect(factors).toEqual([{ years: 1, factor: one }, { years: 2, factor: two }]);
    expect(discountFactor(factors, 2)).toBeCloseTo(two, 12);
    expect(forwardCurve(curve, "par", 1)[0]!.yield).toBeCloseTo(100 * (one / two - 1), 9);
  });

  test("money-market tenors discount simply and forward simply", () => {
    // Semi-annual coupons: 3M is shorter than a coupon period.
    const curve = [node(0.25, 4), node(0.5, 4.2), node(1, 4.4), node(2, 4.6)];
    const factors = bootstrapDiscountFactors(curve, 2);
    expect(factors[0]).toEqual({ years: 0.25, factor: 1 / (1 + 0.04 * 0.25) });
    const [threeMonths] = forwardCurve(curve, "par", 2);
    const start = discountFactor(factors, 1)!;
    const end = discountFactor(factors, 1.25)!;
    expect(threeMonths!.yield).toBeCloseTo(100 * (start / end - 1) / 0.25, 9);
  });

  test("a zero curve forwards by continuously compounded rates", () => {
    const forward = forwardCurve([node(0.5, 3.8), node(1, 4), node(2, 5)], "zero", 2);
    expect(forward.find((point) => point.id === "1Y")!.yield).toBeCloseTo((2 * 5 - 1 * 4) / 1, 9);
    // 1.5 years sits halfway between the 1Y and 2Y rates.
    expect(forward.find((point) => point.id === "6M")!.yield).toBeCloseTo((1.5 * 4.5 - 1 * 4) / 0.5, 9);
  });

  test("curves starting past the horizon, and spreads, have no forward curve", () => {
    const tips = [5, 7, 10, 20, 30].map((years) => node(years, 2.8));
    expect(forwardCurve(tips, "par", 2)).toEqual([]);
    expect(forwardCurve([node(1, 2), node(10, 2.3)], "spread", 2)).toEqual([]);
  });
});
