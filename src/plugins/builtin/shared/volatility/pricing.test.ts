import { describe, expect, test } from "bun:test";
import { daysToExpiryFrom, solveImpliedVolatility, valueOption, type OptionPricingInput } from "./pricing";

const CANONICAL: OptionPricingInput = {
  side: "call",
  spot: 100,
  strike: 100,
  daysToExpiry: 365,
  rate: 0.05,
  volatility: 0.2,
  dividendYield: 0,
};

describe("valueOption", () => {
  test("matches the textbook Black-Scholes call and put", () => {
    expect(valueOption(CANONICAL).price).toBeCloseTo(10.4506, 3);
    expect(valueOption({ ...CANONICAL, side: "put" }).price).toBeCloseTo(5.5735, 3);
  });

  test("respects put-call parity with a dividend yield", () => {
    const draft = { ...CANONICAL, spot: 120, strike: 110, dividendYield: 0.03 };
    const call = valueOption(draft).price;
    const put = valueOption({ ...draft, side: "put" }).price;
    const forward = draft.spot * Math.exp(-draft.dividendYield) - draft.strike * Math.exp(-draft.rate);

    expect(call - put).toBeCloseTo(forward, 6);
  });

  test("reports the greeks in per-day and per-point units", () => {
    const greeks = valueOption(CANONICAL);

    expect(greeks.delta).toBeCloseTo(0.6368, 3);
    expect(greeks.gamma).toBeCloseTo(0.0188, 3);
    // Annual theta is about -6.41, vega about 37.52, rho about 53.23 in unit terms.
    expect(greeks.thetaPerDay).toBeCloseTo(-6.414 / 365, 4);
    expect(greeks.vegaPerPoint).toBeCloseTo(0.3752, 3);
    expect(greeks.rhoPerPoint).toBeCloseTo(0.5323, 3);
  });

  test("falls back to discounted intrinsic value at the degenerate edges", () => {
    expect(valueOption({ ...CANONICAL, daysToExpiry: 0, spot: 110 }).price).toBeCloseTo(10, 6);
    expect(valueOption({ ...CANONICAL, daysToExpiry: 0, spot: 90 }).price).toBe(0);
    expect(valueOption({ ...CANONICAL, volatility: 0 }).price)
      .toBeCloseTo(100 - 100 * Math.exp(-0.05), 6);
  });

  test("zero-volatility theta and rho agree with changes in the discounted payoff", () => {
    for (const side of ["call", "put"] as const) {
      const draft = { ...CANONICAL, side, spot: side === "call" ? 120 : 80, volatility: 0, dividendYield: 0.02 };
      const value = valueOption(draft);
      const dayStep = 0.001;
      const rateStep = 0.000001;
      const theta = (valueOption({ ...draft, daysToExpiry: draft.daysToExpiry - dayStep }).price
        - valueOption({ ...draft, daysToExpiry: draft.daysToExpiry + dayStep }).price) / (2 * dayStep);
      const rho = (valueOption({ ...draft, rate: draft.rate + rateStep }).price
        - valueOption({ ...draft, rate: draft.rate - rateStep }).price) / (2 * rateStep * 100);
      expect(value.thetaPerDay).toBeCloseTo(theta, 7);
      expect(value.rhoPerPoint).toBeCloseTo(rho, 7);
      expect(valueOption({ ...draft, daysToExpiry: 0 }).rhoPerPoint).toBe(0);
    }
  });

  test("never returns NaN or Infinity for impossible inputs", () => {
    const broken: OptionPricingInput[] = [
      { ...CANONICAL, spot: 0 },
      { ...CANONICAL, strike: 0 },
      { ...CANONICAL, spot: Number.NaN },
      { ...CANONICAL, daysToExpiry: -10 },
      { ...CANONICAL, volatility: -1 },
      { ...CANONICAL, rate: Number.POSITIVE_INFINITY },
    ];

    for (const draft of broken) {
      for (const value of Object.values(valueOption(draft))) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe("solveImpliedVolatility", () => {
  test("round-trips a priced option back to its volatility", () => {
    for (const volatility of [0.05, 0.2, 0.85, 2.4]) {
      for (const side of ["call", "put"] as const) {
        const draft = { ...CANONICAL, side, volatility };
        const solved = solveImpliedVolatility(draft, valueOption(draft).price);

        expect(solved.volatility).toBeCloseTo(volatility, 5);
      }
    }
  });

  test("rejects a market price below intrinsic value", () => {
    const draft = { ...CANONICAL, spot: 150 };
    const result = solveImpliedVolatility(draft, 1);

    expect(result.volatility).toBeNull();
    expect(result.note).toMatch(/intrinsic/);
  });

  test("distinguishes impossible prices from prices above the solver ceiling", () => {
    const aboveCeiling = solveImpliedVolatility(CANONICAL, 99);
    const impossible = solveImpliedVolatility(CANONICAL, 101);

    expect(aboveCeiling.volatility).toBeNull();
    expect(aboveCeiling.note).toMatch(/volatility above/);
    expect(impossible.volatility).toBeNull();
    expect(impossible.note).toMatch(/no-arbitrage maximum/);
  });

  test("stays silent when no market price was entered", () => {
    expect(solveImpliedVolatility(CANONICAL, 0)).toEqual({ volatility: null, note: null });
  });

  test("says so instead of solving an expired contract", () => {
    const result = solveImpliedVolatility({ ...CANONICAL, daysToExpiry: 0 }, 5);

    expect(result.volatility).toBeNull();
    expect(result.note).toMatch(/expired/);
  });
});

test("prices time through the expiration session close", () => {
  const now = Date.UTC(2026, 7, 20, 18, 0, 0);
  expect(daysToExpiryFrom(Date.UTC(2026, 7, 28) / 1000, now)).toBeCloseTo(8 + 2 / 24, 8);
  // Midnight has passed, but a same-day contract keeps its final two hours.
  expect(daysToExpiryFrom(Date.UTC(2026, 7, 20) / 1000, now)).toBeCloseTo(2 / 24, 8);
  expect(daysToExpiryFrom(Date.UTC(2026, 7, 19) / 1000, now)).toBe(0);
});

test("IV distinguishes exact zero-volatility prices from numerically unresolved nearby prices", () => {
  for (const side of ["call", "put"] as const) {
    const draft={...CANONICAL,side,spot:side==="call"?150:50,daysToExpiry:1,rate:-.01,dividendYield:.02};
    const lower=valueOption({...draft,volatility:0}).price;
    expect(solveImpliedVolatility(draft,lower)).toEqual({volatility:0,note:null});
    for(const offset of [-.000001,.000001]) {
      const result=solveImpliedVolatility(draft,lower+offset);
      expect(result.volatility).toBeNull();expect(result.note).toContain("model bound");
    }
    expect(solveImpliedVolatility(draft,lower-.01).note).toContain("below intrinsic");
  }
});

test("an asymptotic maximum and collapsed numerical bounds cannot produce a finite IV", () => {
  const long={...CANONICAL,daysToExpiry:36500,rate:0};
  expect(solveImpliedVolatility(long,100)).toEqual({volatility:null,note:"no finite IV at the model maximum"});
  expect(solveImpliedVolatility({...CANONICAL,rate:-1e308},50).volatility).toBeNull();
  expect(solveImpliedVolatility({...CANONICAL,strike:1e-30},100).note).toContain("precision");
});
