import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OPTION_CALC_DRAFT,
  buildOptionCalcParams,
  daysToExpiryFrom,
  describeDraftProblem,
  draftFromParams,
  solveImpliedVolatility,
  valueOption,
  type OptionCalcDraft,
} from "./model";

const CANONICAL: OptionCalcDraft = {
  ...DEFAULT_OPTION_CALC_DRAFT,
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

  test("never returns NaN or Infinity for impossible inputs", () => {
    const broken: OptionCalcDraft[] = [
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

describe("seeding", () => {
  const now = Date.UTC(2026, 7, 20, 18, 0, 0);

  test("prices time through the expiration session close", () => {
    expect(daysToExpiryFrom(Date.UTC(2026, 7, 28) / 1000, now)).toBeCloseTo(8 + 2 / 24, 8);
    // Midnight has passed, but a same-day contract keeps its final two hours.
    expect(daysToExpiryFrom(Date.UTC(2026, 7, 20) / 1000, now)).toBeCloseTo(2 / 24, 8);
    expect(daysToExpiryFrom(Date.UTC(2026, 7, 19) / 1000, now)).toBe(0);
  });

  test("round-trips a seeded contract through pane params", () => {
    const params = buildOptionCalcParams({
      symbol: "aapl",
      side: "put",
      spot: 231.5,
      strike: 230,
      expiration: Date.UTC(2026, 8, 19) / 1000,
      volatility: 0.284,
      marketPrice: 7.35,
      dividendYield: 0.0044,
    }, now);

    expect(draftFromParams(params)).toEqual({
      symbol: "AAPL",
      side: "put",
      spot: 231.5,
      strike: 230,
      daysToExpiry: 30 + 2 / 24,
      rate: DEFAULT_OPTION_CALC_DRAFT.rate,
      volatility: 0.284,
      dividendYield: 0.0044,
      marketPrice: 7.35,
    });
  });

  test("drops seed values a chain reports as zero rather than seeding zeros", () => {
    const params = buildOptionCalcParams({ symbol: "MSFT", spot: 400, volatility: 0, marketPrice: 0 }, now);

    expect(params.volatility).toBeUndefined();
    expect(params.marketPrice).toBeUndefined();
    expect(draftFromParams(params).volatility).toBe(DEFAULT_OPTION_CALC_DRAFT.volatility);
  });

  test("uses defaults when the pane is opened standalone", () => {
    expect(draftFromParams(undefined)).toEqual(DEFAULT_OPTION_CALC_DRAFT);
    expect(draftFromParams({})).toEqual(DEFAULT_OPTION_CALC_DRAFT);
  });
});

describe("describeDraftProblem", () => {
  test("names the first unusable input", () => {
    expect(describeDraftProblem(CANONICAL)).toBeNull();
    expect(describeDraftProblem({ ...CANONICAL, spot: 0 })).toMatch(/Spot/);
    expect(describeDraftProblem({ ...CANONICAL, volatility: -0.1 })).toMatch(/Volatility/);
  });
});
