import { describe, expect, test } from "bun:test";
import { DEFAULT_OPTION_CALC_DRAFT, valueOption, type OptionCalcDraft } from "./model";
import { effectiveBinomialSteps, priceBinomialOption, solveBinomialImpliedVolatility, validateBinomialInputs,
  valueBinomialOption, type BinomialInputs, type CashDividend } from "./binomial";

const canonical: OptionCalcDraft = { ...DEFAULT_OPTION_CALC_DRAFT, spot: 100, strike: 100,
  daysToExpiry: 365, rate: 0.05, volatility: 0.2, dividendYield: 0 };
const european = { exercise: "european" as const, steps: 800 };

/** Independent conditioning integral: lognormal before the one cash event, BS after it. */
function oneDividendEuropean(draft: OptionCalcDraft, dividend: CashDividend): number {
  const years = dividend.days / 365;
  const intervals = 12_000;
  const step = 18 / intervals;
  let total = 0;
  for (let i = 0; i <= intervals; i += 1) {
    const z = -9 + i * step;
    const before = draft.spot * Math.exp((draft.rate - draft.dividendYield - draft.volatility ** 2 / 2) * years
      + draft.volatility * Math.sqrt(years) * z);
    const after = Math.max(0, before - dividend.amount);
    const value = valueOption({ ...draft, spot: after, daysToExpiry: draft.daysToExpiry - dividend.days }).price;
    total += value * Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * (i === 0 || i === intervals ? 1 : i % 2 ? 4 : 2);
  }
  return total * step / 3 * Math.exp(-draft.rate * years);
}

describe("CRR convergence and exercise", () => {
  test("European calls and puts converge to the shared closed form with continuous carry", () => {
    for (const side of ["call", "put"] as const) {
      for (const dividendYield of [0, 0.03]) {
        const draft = { ...canonical, side, dividendYield };
        const exact = valueOption(draft).price;
        const coarse = priceBinomialOption(draft, { ...european, steps: 100 });
        const fine = priceBinomialOption(draft, european);
        expect(Math.abs(fine - exact)).toBeLessThan(Math.abs(coarse - exact));
        expect(Math.abs(fine - exact)).toBeLessThan(0.004);
      }
    }
  });

  test("American put matches the established 36/40 benchmark and dominates European exercise", () => {
    const draft = { ...canonical, spot: 36, strike: 40, side: "put" as const, rate: 0.06 };
    expect(priceBinomialOption(draft, { steps: 1600 })).toBeCloseTo(4.4868, 3);
    expect(priceBinomialOption(draft)).toBeGreaterThan(priceBinomialOption(draft, european));
    expect(priceBinomialOption(canonical)).toBeCloseTo(priceBinomialOption(canonical, { exercise: "european" }), 8);
  });

  test("invalid CRR probabilities refine the mesh instead of clipping the carry", () => {
    const draft = { ...canonical, rate: 0.3, volatility: 0.1 };
    const steps = effectiveBinomialSteps(draft, { steps: 1 });
    expect(steps).toBeGreaterThan(1);
    const dt = 1 / steps;
    const up = Math.exp(draft.volatility * Math.sqrt(dt));
    const probability = (Math.exp(draft.rate * dt) - 1 / up) / (up - 1 / up);
    expect(probability).toBeGreaterThan(0);
    expect(probability).toBeLessThan(1);
    expect(priceBinomialOption(draft, { steps: 1 })).toBeCloseTo(priceBinomialOption(draft, { steps }), 8);
    expect(() => priceBinomialOption({ ...draft, volatility: 1e-12 })).toThrow(/resolution/);
    expect(priceBinomialOption({ ...draft, volatility: 0 })).toBeCloseTo(100 - 100 * Math.exp(-0.3), 8);
  });

  test("negative rates preserve European convergence and the option to postpone a put exercise", () => {
    const draft = { ...canonical, side: "put" as const, rate: -0.04, dividendYield: 0.01 };
    expect(priceBinomialOption(draft, european)).toBeCloseTo(valueOption(draft).price, 2);
    const zeroSpot = { ...draft, spot: 0 };
    expect(priceBinomialOption(zeroSpot)).toBeCloseTo(100 * Math.exp(0.04), 8);
    expect(priceBinomialOption({ ...zeroSpot, rate: 0.04 })).toBe(100);
  });
});

describe("discrete cash dividends", () => {
  test("cash jumps converge to an independent conditional expectation, distinct from adjusted spot", () => {
    const dividend = { days: 182.5, amount: 8 };
    for (const side of ["call", "put"] as const) {
      const draft = { ...canonical, side, dividendYield: 0.015 };
      const exact = oneDividendEuropean(draft, dividend);
      const coarse = priceBinomialOption(draft, { ...european, steps: 100, dividends: [dividend] });
      const fine = priceBinomialOption(draft, { ...european, steps: 1600, dividends: [dividend] });
      expect(Math.abs(fine - exact)).toBeLessThan(Math.abs(coarse - exact));
      expect(Math.abs(fine - exact)).toBeLessThan(0.01);
      const adjusted = valueOption({ ...draft, spot: draft.spot - dividend.amount * Math.exp(-draft.rate * 0.5) }).price;
      expect(Math.abs(fine - adjusted)).toBeGreaterThan(0.08);
    }
  });

  test("cash amount and payment timing affect prices and continuous yield remains separate", () => {
    const early = [{ days: 60, amount: 4 }];
    const larger = [{ days: 60, amount: 8 }];
    const late = [{ days: 300, amount: 4 }];
    for (const side of ["call", "put"] as const) {
      const draft = { ...canonical, side };
      const small = priceBinomialOption(draft, { ...european, dividends: early });
      const large = priceBinomialOption(draft, { ...european, dividends: larger });
      if (side === "call") expect(large).toBeLessThan(small); else expect(large).toBeGreaterThan(small);
    }
    expect(priceBinomialOption(canonical, { ...european, dividends: early }))
      .toBeLessThan(priceBinomialOption(canonical, { ...european, dividends: late }));
    expect(priceBinomialOption({ ...canonical, dividendYield: 0.02 }, { ...european, dividends: early }))
      .toBeLessThan(priceBinomialOption(canonical, { ...european, dividends: early }));
  });

  test("American calls exercise before cash distributions when that exceeds continuation", () => {
    const draft = { ...canonical, spot: 200, strike: 100, volatility: 0.15, rate: 0.04 };
    const options = { steps: 800, dividends: [{ days: 10, amount: 20 }] };
    const american = priceBinomialOption(draft, options);
    expect(american).toBeGreaterThan(priceBinomialOption(draft, { ...options, exercise: "european" }));
    // The deep ITM call has negligible probability of missing exercise before
    // the distribution, so discount the strike through that event only.
    expect(american).toBeCloseTo(200 - 100 * Math.exp(-0.04 * 10 / 365), 2);
  });

  test("same-date payments merge and separate event dates are kept", () => {
    const combined = [{ days: 90, amount: 3 }, { days: 270, amount: 4 }];
    const split = [{ days: 270, amount: 1.5 }, { days: 90, amount: 1 },
      { days: 90, amount: 2 }, { days: 270, amount: 2.5 }, { days: 10, amount: 0 }];
    expect(priceBinomialOption(canonical, { dividends: combined })).toBe(priceBinomialOption(canonical, { dividends: split }));
    expect(priceBinomialOption(canonical, { dividends: combined })).not.toBe(priceBinomialOption(canonical, { dividends: [{ days: 90, amount: 7 }] }));
  });

  test("immediate distributions floor the stock at zero and permit exercise on both sides of the jump", () => {
    const options = { dividends: [{ days: 0, amount: 120 }] };
    expect(priceBinomialOption(canonical, { ...options, exercise: "european" })).toBe(0);
    expect(priceBinomialOption({ ...canonical, side: "put" }, { ...options, exercise: "european" }))
      .toBeCloseTo(100 * Math.exp(-0.05), 8);
    expect(priceBinomialOption({ ...canonical, side: "put" }, options)).toBeCloseTo(100, 8);
    expect(priceBinomialOption({ ...canonical, strike: 90 }, options)).toBeCloseTo(10, 8);
  });

  test("a distribution on expiry precedes the terminal payoff with pre-dividend American exercise", () => {
    const draft = { ...canonical, strike: 80, volatility: 0, rate: 0 };
    const options = { dividends: [{ days: 365, amount: 30 }] };
    expect(priceBinomialOption(draft, { ...options, exercise: "european" })).toBe(0);
    expect(priceBinomialOption(draft, options)).toBe(20);
    const instant = { ...draft, daysToExpiry: 0 };
    expect(priceBinomialOption(instant, { exercise: "european", dividends: [{ days: 0, amount: 30 }] })).toBe(0);
    expect(priceBinomialOption(instant, { dividends: [{ days: 0, amount: 30 }] })).toBe(20);
  });
});

describe("deterministic and degenerate boundaries", () => {
  test("zero-volatility exercise searches between events, including an interior optimum", () => {
    const draft = { ...canonical, side: "put" as const, spot: 80, strike: 100, daysToExpiry: 3650,
      rate: 0.1, dividendYield: 0.2, volatility: 0 };
    expect(priceBinomialOption(draft)).toBeCloseTo(31.25, 8);
    expect(priceBinomialOption(draft, { exercise: "european" })).toBeCloseTo(valueOption(draft).price, 8);
    const call = { ...canonical, strike: 90, volatility: 0, rate: 0 };
    expect(priceBinomialOption(call, { dividends: [{ days: 100, amount: 20 }] })).toBe(10);
    expect(priceBinomialOption(call, { exercise: "european", dividends: [{ days: 100, amount: 20 }] })).toBe(0);
  });

  test("expired contracts, zero spot and zero strike return finite values and Greeks", () => {
    for (const draft of [{ ...canonical, daysToExpiry: 0, spot: 110 }, { ...canonical, volatility: 0 },
      { ...canonical, spot: 0 }, { ...canonical, strike: 0 }, { ...canonical, spot: 0, side: "put" as const }]) {
      const result = valueBinomialOption(draft);
      expect(Object.values(result).every(Number.isFinite)).toBe(true);
    }
    expect(valueBinomialOption({ ...canonical, daysToExpiry: 0, spot: 110 }))
      .toEqual({ price: 10, delta: 1, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0, rhoPerPoint: 0 });
    expect(priceBinomialOption({ ...canonical, strike: 0 })).toBeCloseTo(100, 8);
    expect(priceBinomialOption({ ...canonical, strike: 0, dividendYield: -0.02 })).toBeCloseTo(100 * Math.exp(0.02), 8);
    expect(priceBinomialOption({ ...canonical, strike: 0, side: "put" })).toBe(0);
  });

  test("malformed inputs and unsupported numerical grids are reported rather than coerced", () => {
    for (const patch of [{ spot: NaN }, { strike: -1 }, { daysToExpiry: -1 }, { rate: Infinity },
      { dividendYield: NaN }, { volatility: -0.1 }]) {
      expect(validateBinomialInputs({ ...canonical, ...patch })).not.toBeNull();
      expect(() => priceBinomialOption({ ...canonical, ...patch })).toThrow();
    }
    const inputs: unknown[] = [null, { steps: null }, { steps: 0 }, { steps: 1.5 }, { steps: 2001 }, { steps: Infinity },
      { exercise: null }, { exercise: "invalid" }, { dividends: null }, { dividends: [{ days: NaN, amount: 1 }] },
      { dividends: [{ days: -1, amount: 1 }] }, { dividends: [{ days: 366, amount: 1 }] },
      { dividends: [{ days: 100, amount: -1 }] }, { dividends: [{ days: 100, amount: Infinity }] }];
    for (const input of inputs) expect(() => priceBinomialOption(canonical, input as Partial<BinomialInputs>)).toThrow();
    expect(() => priceBinomialOption({ ...canonical, rate: 0, volatility: 1e-6 }, { dividends: [{ days: 100, amount: 1 }] })).toThrow(/resolution/);
    expect(() => priceBinomialOption({ ...canonical, rate: 0, volatility: 1e-17 })).toThrow(/resolution/);
  });
});

describe("binomial Greeks and IV", () => {
  test("per-day and per-point Greeks converge to the independent European formulas", () => {
    for (const side of ["call", "put"] as const) {
      const draft = { ...canonical, side, dividendYield: 0.015 };
      const exact = valueOption(draft);
      const computed = valueBinomialOption(draft, european);
      expect(Math.abs(computed.delta - exact.delta)).toBeLessThan(0.001);
      expect(Math.abs(computed.gamma - exact.gamma)).toBeLessThan(0.0001);
      expect(Math.abs(computed.thetaPerDay - exact.thetaPerDay)).toBeLessThan(0.0001);
      expect(Math.abs(computed.vegaPerPoint - exact.vegaPerPoint)).toBeLessThan(0.001);
      expect(Math.abs(computed.rhoPerPoint - exact.rhoPerPoint)).toBeLessThan(0.001);
    }
  });

  test("cash-dividend Greeks agree with perturbing both the stock and the dated cash schedule", () => {
    const draft = { ...canonical, volatility: 0, rate: 0.03, dividendYield: 0.01, strike: 50 };
    const options = { exercise: "european" as const, dividends: [{ days: 120, amount: 4 }] };
    const value = valueBinomialOption(draft, options);
    const delta = (priceBinomialOption({ ...draft, spot: 100.01 }, options) - priceBinomialOption({ ...draft, spot: 99.99 }, options)) / 0.02;
    expect(value.delta).toBeCloseTo(delta, 7);
    const oneDayLater = priceBinomialOption({ ...draft, daysToExpiry: 364 }, { ...options, dividends: [{ days: 119, amount: 4 }] });
    expect(value.thetaPerDay).toBeCloseTo(oneDayLater - value.price, 8);
    const wronglyUndated = priceBinomialOption({ ...draft, daysToExpiry: 364 }, options) - value.price;
    expect(Math.abs(value.thetaPerDay - wronglyUndated)).toBeGreaterThan(0.0002);
    const rateUp = priceBinomialOption({ ...draft, rate: 0.03001 }, options);
    const rateDown = priceBinomialOption({ ...draft, rate: 0.02999 }, options);
    expect(value.rhoPerPoint).toBeCloseTo((rateUp - rateDown) / 0.00002 / 100, 6);
  });

  test("the exercise region has intrinsic Greeks and stable zero optionality sensitivities", () => {
    const value = valueBinomialOption({ ...canonical, spot: 20, side: "put", rate: 0.1 });
    expect(value).toEqual({ price: 80, delta: -1, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0, rhoPerPoint: 0 });
  });

  test("IV round-trips the selected exercise policy and cash-dividend model", () => {
    const options = { steps: 300, dividends: [{ days: 100, amount: 4 }, { days: 250, amount: 3 }] };
    for (const exercise of ["american", "european"] as const) {
      const draft = { ...canonical, side: "put" as const, volatility: 0.31 };
      const selected = { ...options, exercise };
      const price = priceBinomialOption(draft, selected);
      expect(solveBinomialImpliedVolatility(draft, price, selected).volatility).toBeCloseTo(0.31, 5);
    }
  });

  test("IV refuses unidentifiable exercise bounds, impossible maxima and expiry", () => {
    const put = { ...canonical, spot: 80, side: "put" as const };
    expect(solveBinomialImpliedVolatility(put, 20).volatility).toBeNull();
    expect(solveBinomialImpliedVolatility(put, 20).note).toContain("exercise bound");
    expect(solveBinomialImpliedVolatility(put, 19).note).toContain("below immediate exercise");
    expect(solveBinomialImpliedVolatility(canonical, 100).note).toContain("No finite IV");
    expect(solveBinomialImpliedVolatility(canonical, 101).note).toContain("no-arbitrage maximum");
    expect(solveBinomialImpliedVolatility(canonical, 0)).toEqual({ volatility: null, note: null });
    expect(solveBinomialImpliedVolatility(canonical, NaN).volatility).toBeNull();
    expect(solveBinomialImpliedVolatility({ ...canonical, daysToExpiry: 0 }, 5).volatility).toBeNull();
    const euro = { exercise: "european" as const };
    const zeroPrice = priceBinomialOption({ ...canonical, volatility: 0 }, euro);
    expect(solveBinomialImpliedVolatility(canonical, zeroPrice, euro)).toEqual({ volatility: 0, note: null });
    expect(solveBinomialImpliedVolatility(canonical, 99, euro).note).toContain("above 500%");
  });

  test("small positive premiums cannot be mistaken for an exact zero-volatility price", () => {
    const farCall = { ...canonical, strike: 200, rate: 0.04 };
    expect(priceBinomialOption({ ...farCall, volatility: 0 })).toBe(0);
    for (const premium of [1e-7, 1e-6]) {
      const solved = solveBinomialImpliedVolatility(farCall, premium);
      expect(solved.volatility).toBeNull();
      expect(solved.note).toContain("too close");
    }
    const zeroVolPrice = priceBinomialOption({ ...canonical, volatility: 0 }, european);
    expect(solveBinomialImpliedVolatility(canonical, zeroVolPrice + 1e-7, european).volatility).toBeNull();
  });

  test("IV requires a price residual match across adaptive-step dividend-time discontinuities", () => {
    const draft = { ...canonical, side: "put" as const, rate: 0.2 };
    const options = { steps: 1, dividends: [{ days: 180, amount: 15 }] };
    const lower = priceBinomialOption({ ...draft, volatility: 0.19999 }, options);
    const upper = priceBinomialOption({ ...draft, volatility: 0.20001 }, options);
    expect(upper - lower).toBeGreaterThan(9);
    // Crossing this volatility changes the refined mesh from two steps to
    // one, moving the cash event to the origin. No IV prices the midpoint.
    const solved = solveBinomialImpliedVolatility(draft, (lower + upper) / 2, options);
    expect(solved.volatility).toBeNull();
    expect(solved.note).toContain("Tree mesh cannot resolve");
  });
});
