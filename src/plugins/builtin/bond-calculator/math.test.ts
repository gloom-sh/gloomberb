import { describe, expect, test } from "bun:test";
import { bondPeriod, days360US, priceBond, solveBondYield, treasurySpread, type BondTerms } from "./math";

const terms: BondTerms = { settlement: "2026-09-22", maturity: "2031-09-15", couponPercent: 5, frequency: 2, dayCount: "act-act-icma", endOfMonth: false };

describe("regular fixed-coupon analytics", () => {
  // Independent reference: QuantLib 1.43 FixedRateBond, ActualActual(ISMA,
  // schedule), unadjusted backward schedule, zero settlement lag, face 100.
  test.each([
    { settlement: "2026-09-22", maturity: "2031-09-15", couponPercent: 5, yieldPercent: 4.25, endOfMonth: false,
      accrued: 0.0966850828729271, clean: 103.33393700073695, modified: 4.3830847975720895, convexity: 22.66952044893109 },
    { settlement: "2024-02-28", maturity: "2028-08-31", couponPercent: 4, yieldPercent: 3.7, endOfMonth: true,
      accrued: 1.9890109890109864, clean: 101.23373917771588, modified: 4.013056571695582, convexity: 19.194284734046704 },
    { settlement: "2024-02-29", maturity: "2028-08-31", couponPercent: 4, yieldPercent: 4, endOfMonth: true,
      accrued: 0, clean: 99.99999999999996, modified: 4.08111835318354, convexity: 19.477550187267084 },
  ])("matches independent ICMA reference at $settlement", (reference) => {
    const result = priceBond({ ...terms, ...reference }, reference.yieldPercent);
    expect(result.accruedInterest).toBeCloseTo(reference.accrued, 10);
    expect(result.cleanPrice).toBeCloseTo(reference.clean, 10);
    expect(result.modifiedDuration).toBeCloseTo(reference.modified, 10);
    expect(result.convexity).toBeCloseTo(reference.convexity, 10);
    expect(result.dirtyPrice - result.cleanPrice).toBeCloseTo(result.accruedInterest, 12);
  });

  test("matches the published Excel PRICE example on US 30/360", () => {
    const result = priceBond({ ...terms, settlement: "2008-02-15", maturity: "2017-11-15", couponPercent: 5.75, dayCount: "30-360-us" }, 6.5);
    expect(result.cleanPrice).toBeCloseTo(94.63436162132209, 10);
  });

  test("retains explicit month-end roll and excludes an already-paid coupon", () => {
    const result = bondPeriod({ ...terms, settlement: "2024-02-29", maturity: "2025-08-31", endOfMonth: true });
    expect(result.previousCoupon).toBe("2024-02-29");
    expect(result.nextCoupon).toBe("2024-08-31");
    expect(result.couponDates).toEqual(["2024-08-31", "2025-02-28", "2025-08-31"]);
    expect(result.accruedInterest).toBe(0);
    expect(result.firstPeriodFraction).toBe(1);
    expect(bondPeriod({ ...terms, settlement: "2024-05-01", maturity: "2025-04-30", endOfMonth: false }).nextCoupon).toBe("2024-10-30");
    expect(bondPeriod({ ...terms, settlement: "2024-05-01", maturity: "2025-04-30", endOfMonth: true }).nextCoupon).toBe("2024-10-31");
  });

  test.each(["act-act-icma", "30-360-us"] as const)("duration, convexity and DV01 match numerical sensitivities for %s", (dayCount) => {
    const selected = { ...terms, dayCount };
    const value = priceBond(selected, 4.25);
    const lower = priceBond(selected, 4.24).dirtyPrice;
    const upper = priceBond(selected, 4.26).dirtyPrice;
    const basisPoint = 0.0001;
    expect(value.modifiedDuration).toBeCloseTo((lower - upper) / (2 * basisPoint * value.dirtyPrice), 5);
    expect(value.convexity).toBeCloseTo((lower + upper - 2 * value.dirtyPrice) / (basisPoint ** 2 * value.dirtyPrice), 4);
    expect(value.dv01).toBeCloseTo((lower - upper) / 2, 7);
    expect(value.macaulayDuration).toBeCloseTo(value.modifiedDuration * (1 + 0.0425 / 2), 12);
  });

  test.each([1, 2, 4] as const)("yield inversion handles premium, discount and negative yields at frequency %s", (frequency) => {
    for (const yieldPercent of [-1, 0, 4.25, 12, 40]) {
      const selected = { ...terms, frequency };
      const price = priceBond(selected, yieldPercent).cleanPrice;
      expect(solveBondYield(selected, price)).toBeCloseTo(yieldPercent, 7);
    }
  });

  test("zero-coupon cash flows stay finite at deeply negative feasible yields", () => {
    const selected = { ...terms, settlement: "2026-09-22", maturity: "2030-09-22", frequency: 1 as const, couponPercent: 0 };
    const result = priceBond(selected, -50);
    expect(result.cleanPrice).toBeCloseTo(100 / 0.5 ** 4, 10);
    expect(result.macaulayDuration).toBe(4);
    expect(solveBondYield(selected, result.cleanPrice)).toBeCloseTo(-50, 8);
    expect(() => priceBond(selected, -100)).toThrow("Yield must exceed");
  });

  test("rejects invalid dates, expired bonds and an ambiguous end-of-month schedule", () => {
    expect(() => bondPeriod({ ...terms, settlement: "2026-02-30" })).toThrow("valid YYYY-MM-DD");
    expect(() => bondPeriod({ ...terms, settlement: terms.maturity })).toThrow("Maturity must follow");
    expect(() => bondPeriod({ ...terms, endOfMonth: true })).toThrow("month-end maturity");
  });
});

describe("US 30/360 boundaries", () => {
  // Matches QuantLib Thirty360(USA), which differs from 30E/360 at February.
  test.each([
    ["2025-08-31", "2026-02-28", 178],
    ["2026-02-28", "2026-08-31", 180],
    ["2024-02-29", "2025-02-28", 360],
    ["2024-01-31", "2024-02-29", 29],
    ["2024-01-30", "2024-01-31", 0],
  ])("counts %s to %s", (start, end, expected) => expect(days360US(start, end)).toBe(expected));
});

test("Treasury spread interpolates same-date par yields without extrapolating or calling it a Z-spread", () => {
  const selected = { ...terms, maturity: "2030-09-22" };
  const curve = [{ maturityYears: 2, yieldPercent: 4, asOf: "2026-09-21" }, { maturityYears: 5, yieldPercent: 4.6, asOf: "2026-09-21" }];
  const spread = treasurySpread(selected, 5, curve)!;
  expect(spread.benchmarkPercent).toBeCloseTo(4.4, 12);
  expect(spread.spreadBps).toBeCloseTo(60, 10);
  expect(spread.asOf).toBe("2026-09-21");
  expect(treasurySpread(selected, 5, [curve[0]!])).toBeNull();
  expect(treasurySpread(selected, 5, [curve[0]!, { ...curve[1]!, asOf: "2026-09-18" }])).toBeNull();
});
