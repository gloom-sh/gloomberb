import { describe, expect, test } from "bun:test";
import { daysToExpiryFrom, valueOption } from "../options-calculator/model";
import {
  buildScenario, expiryRisk, optionExpirationClose, parseLegs, scenarioValue, serializeLegs, validatePosition,
  type ScenarioLeg, type ScenarioPosition,
} from "./model";

const DAY_MS = 86_400_000;
const AS_OF = Date.UTC(2026, 8, 22, 16);
const EXPIRATION = Date.UTC(2026, 11, 18) / 1000;
const leg = (patch: Partial<ScenarioLeg> = {}): ScenarioLeg => ({ id: "call", side: "call", quantity: 1,
  strike: 100, expiration: EXPIRATION, price: 5, volatility: 0.25, multiplier: 100, ...patch });
const position = (legs: ScenarioLeg[] = [leg()], patch: Partial<ScenarioPosition> = {}): ScenarioPosition => ({
  symbol: "TEST", currency: "USD", spot: 100, rate: 0.04, dividendYield: 0.015, asOf: AS_OF, legs, ...patch,
});

describe("scenario aggregation", () => {
  const legs = [leg({ quantity: 2 }), leg({ id: "put", side: "put", strike: 95, quantity: -3,
    price: 3.5, multiplier: 10, volatility: 0.31 })];
  const p = position(legs);
  const date = AS_OF + 5 * DAY_MS;
  const shift = 0.04;

  test("signed quantities and per-leg multipliers apply to every value and entry cash flow", () => {
    const result = scenarioValue(p, 103, date, shift);
    const singles = legs.map((item) => valueOption({ symbol: p.symbol, side: item.side, spot: 103,
      strike: item.strike, daysToExpiry: daysToExpiryFrom(item.expiration, date), rate: p.rate,
      dividendYield: p.dividendYield, volatility: item.volatility + shift, marketPrice: 0 }));
    for (const key of ["price", "delta", "gamma", "thetaPerDay", "vegaPerPoint", "rhoPerPoint"] as const) {
      expect(result[key]).toBeCloseTo(singles[0]![key] * 200 - singles[1]![key] * 30, 8);
    }
    expect(result.pnl).toBeCloseTo(result.price - (5 * 200 - 3.5 * 30), 8);
    const opposite = scenarioValue(position(legs.map((item) => ({ ...item, quantity: -item.quantity }))), 103, date, shift);
    for (const key of Object.keys(result) as Array<keyof typeof result>) expect(opposite[key]).toBeCloseTo(-result[key], 8);
  });

  test("aggregate Greeks agree with perturbations in position P&L in displayed units", () => {
    const spot = 103;
    const result = scenarioValue(p, spot, date, shift);
    const ds = 0.02, dv = 0.00001, dr = 0.000001, dt = 0.001;
    const at = (spot: number, date: number, volShift: number) => scenarioValue(p, spot, date, volShift).pnl;
    const up = at(spot + ds, date, shift), down = at(spot - ds, date, shift);
    expect(result.delta).toBeCloseTo((up - down) / (2 * ds), 2);
    expect(result.gamma).toBeCloseTo((up + down - 2 * result.pnl) / (ds * ds), 2);
    expect(result.thetaPerDay).toBeCloseTo((at(spot, date + dt * DAY_MS, shift)
      - at(spot, date - dt * DAY_MS, shift)) / (2 * dt), 3);
    expect(result.vegaPerPoint).toBeCloseTo((at(spot, date, shift + dv) - at(spot, date, shift - dv)) / (200 * dv), 3);
    const rateUp = scenarioValue({ ...p, rate: p.rate + dr }, spot, date, shift).pnl;
    const rateDown = scenarioValue({ ...p, rate: p.rate - dr }, spot, date, shift).pnl;
    expect(result.rhoPerPoint).toBeCloseTo((rateUp - rateDown) / (200 * dr), 3);
  });

  test("expiry has intrinsic value and keeps the signed premium already paid or received", () => {
    const result = scenarioValue(p, 110, optionExpirationClose(EXPIRATION));
    expect(result).toEqual({ price: 2000, pnl: 1105, delta: 200, gamma: 0, thetaPerDay: 0,
      vegaPerPoint: 0, rhoPerPoint: 0 });
  });

  test("zero spot and zero volatility preserve finite discounted payoff and Greeks", () => {
    const p = position([leg({ side: "put", volatility: 0, strike: 90 })], { spot: 0 });
    const value = scenarioValue(p, 0, AS_OF);
    const years = daysToExpiryFrom(EXPIRATION, AS_OF) / 365;
    expect(value.price).toBeCloseTo(9000 * Math.exp(-p.rate * years), 8);
    expect(value.delta).toBeCloseTo(-100 * Math.exp(-p.dividendYield * years), 8);
    expect(value.gamma).toBe(0);
    expect(value.vegaPerPoint).toBe(0);
    const scenario = buildScenario(p);
    expect(scenario.grid.every((row) => row.move === null)).toBe(true);
    expect(scenario.payoff.every((point) => Object.values(point).every(Number.isFinite))).toBe(true);
    expect(JSON.stringify(scenario)).not.toContain("NaN");
    expect(scenario.grid.at(-1)!.spot).toBeGreaterThan(90);
  });
});

describe("exact terminal risk", () => {
  test("debit spread roots and bounds are independent of the chart spot range", () => {
    const p = position([leg({ strike: 100, price: 7 }), leg({ id: "short", strike: 110, quantity: -1, price: 3 })]);
    expect(expiryRisk(p)).toEqual({ breakevens: [104], maxProfit: 600, maxLoss: 400,
      unlimitedProfit: false, unlimitedLoss: false, reason: null });
    expect(buildScenario(p, { spotRange: 0.001 }).expiryRisk).toEqual(expiryRisk(p));
    const reversed = position(p.legs.map((item) => ({ ...item, quantity: -item.quantity })));
    expect(expiryRisk(reversed)).toMatchObject({ breakevens: [104], maxProfit: 400, maxLoss: 600 });
  });

  test("long and short straddles include both roots and identify the infinite tail", () => {
    const p = position([leg({ price: 6 }), leg({ id: "put", side: "put", price: 4 })]);
    expect(expiryRisk(p)).toEqual({ breakevens: [90, 110], maxProfit: null, maxLoss: 1000,
      unlimitedProfit: true, unlimitedLoss: false, reason: null });
    expect(expiryRisk(position(p.legs.map((item) => ({ ...item, quantity: -1 }))))).toEqual({
      breakevens: [90, 110], maxProfit: 1000, maxLoss: null, unlimitedProfit: false, unlimitedLoss: true, reason: null,
    });
  });

  test("the nonnegative spot boundary makes a long put's maximum finite", () => {
    expect(expiryRisk(position([leg({ side: "put", price: 5 })]))).toEqual({
      breakevens: [95], maxProfit: 9500, maxLoss: 500, unlimitedProfit: false, unlimitedLoss: false, reason: null,
    });
    expect(expiryRisk(position([leg({ side: "put", quantity: -2, multiplier: 10, price: 5 })]))).toMatchObject({
      breakevens: [95], maxProfit: 100, maxLoss: 1900,
    });
  });

  test("finds a kink root exactly once and reports bounded zero-profit intervals by their boundaries", () => {
    const butterfly = position([leg({ strike: 90, price: 5 }), leg({ id: "middle", strike: 100, quantity: -2, price: 0 }),
      leg({ id: "high", strike: 110, price: 5 })]);
    expect(expiryRisk(butterfly)).toMatchObject({ breakevens: [100], maxProfit: 0, maxLoss: 1000 });
    expect(expiryRisk(position([leg({ price: 0 })]))).toMatchObject({ breakevens: [0, 100], maxLoss: 0, unlimitedProfit: true });
  });

  test("fractional multiplier cancellation does not manufacture an infinite tail", () => {
    const p = position([leg({ multiplier: 0.1 }), leg({ id: "second", multiplier: 0.2 }),
      leg({ id: "short", quantity: -1, multiplier: 0.3 })]);
    expect(expiryRisk(p)).toMatchObject({ unlimitedProfit: false, unlimitedLoss: false });
    expect(expiryRisk(position([leg({ multiplier: 0.1000001 }),
      leg({ id: "short", quantity: -1, multiplier: 0.1 })])).unlimitedProfit).toBe(true);
  });

  test("mixed expirations do not claim terminal roots or sampled maxima", () => {
    const p = position([leg(), leg({ id: "later", quantity: -1, expiration: Date.UTC(2027, 0, 15) / 1000 })]);
    expect(expiryRisk(p)).toMatchObject({ breakevens: [], maxProfit: null, maxLoss: null,
      unlimitedProfit: false, unlimitedLoss: false });
    expect(expiryRisk(p).reason).toContain("Mixed expirations");
    const result = buildScenario(p);
    expect(result.warnings.some((warning) => warning.includes("Mixed expirations"))).toBe(true);
    const atMoney = result.payoff.find((point) => point.spot === 100)!;
    const remainingLeg = valueOption({ symbol: "TEST", side: "call", spot: 100, strike: 100,
      rate: p.rate, dividendYield: p.dividendYield, volatility: 0.25, marketPrice: 0,
      daysToExpiry: daysToExpiryFrom(p.legs[1]!.expiration, result.expiryDate) });
    expect(atMoney.expiry).toBeCloseTo(-100 * remainingLeg.price, 8);
    expect(result.dates.at(-1)).toBe(optionExpirationClose(EXPIRATION));
  });
});

describe("scenario controls and dates", () => {
  test("grid dates span through the first 16:00 ET close, with uniform tenor spacing", () => {
    const scenario = buildScenario(position());
    expect(scenario.grid).toHaveLength(11);
    expect(scenario.grid[0]!.spot).toBe(80);
    expect(scenario.grid[5]!.move).toBe(0);
    expect(scenario.grid.at(-1)!.spot).toBe(120);
    expect(scenario.dates).toHaveLength(5);
    expect(scenario.dates[0]).toBe(AS_OF);
    expect(scenario.expiryDate).toBe(Date.UTC(2026, 11, 18, 21));
    for (let i = 1; i < 5; i += 1) {
      expect(scenario.dates[i]! - scenario.dates[i - 1]!).toBe((scenario.expiryDate - AS_OF) / 4);
    }
    expect(optionExpirationClose(Date.UTC(2026, 8, 25, 23) / 1000)).toBe(Date.UTC(2026, 8, 25, 20));
  });

  test("clamps selected dates to the supported horizon but rejects unsafe direct valuations", () => {
    const p = position();
    const close = optionExpirationClose(EXPIRATION);
    expect(buildScenario(p, { date: AS_OF - DAY_MS }).controls.date).toBe(AS_OF);
    const last = buildScenario(p, { date: close + DAY_MS });
    expect(last.controls.date).toBe(close);
    expect(last.warnings).toHaveLength(1);
    expect(last.payoff.every((point) => point.selected === point.expiry)).toBe(true);
    expect(() => scenarioValue(p, 100, close + 1)).toThrow(/first expiration/);
    expect(() => scenarioValue(p, 100, AS_OF - 1)).toThrow(/as-of/);
  });

  test("rejects stale expired positions instead of reusing current spot as settlement", () => {
    const close = optionExpirationClose(EXPIRATION);
    const expired = position([leg()], { asOf: close + 1 });
    expect(validatePosition(expired)).toContain("has expired");
    expect(() => buildScenario(expired)).toThrow(/has expired/);
    expect(expiryRisk(expired).maxProfit).toBeNull();
    const atClose = buildScenario(position([leg()], { asOf: close }));
    expect(atClose.dates).toEqual([close]);
    expect(atClose.valuation.pnl).toBe(-500);
  });

  test("an additive vol shift affects every date before expiry and floors only below zero", () => {
    const p = position();
    const base = buildScenario(p);
    const shifted = buildScenario(p, { volShift: 0.1 });
    expect(shifted.valuation.price).toBeGreaterThan(base.valuation.price);
    expect(shifted.payoff.map((point) => point.expiry)).toEqual(base.payoff.map((point) => point.expiry));
    const floored = buildScenario(p, { volShift: -0.4 });
    expect(floored.valuation).toEqual(scenarioValue(position([leg({ volatility: 0 })]), 100, AS_OF));
    expect(floored.warnings).toContain("Shifted volatility was floored at zero.");
  });
});

describe("typed legs and restored inputs", () => {
  test("round-trips signed legs, zero premium/IV and custom multipliers", () => {
    const legs = parseLegs("call,100,2026-12-18,2,5.25,25; put,90,2026-12-18,-1,0,0,10");
    expect(legs[0]).toMatchObject({ quantity: 2, price: 5.25, volatility: 0.25, multiplier: 100 });
    expect(legs[1]).toMatchObject({ side: "put", quantity: -1, price: 0, volatility: 0, multiplier: 10 });
    expect(parseLegs(serializeLegs(legs))).toEqual(legs);
    expect(validatePosition(JSON.parse(JSON.stringify(position(legs))))).toBeNull();
    const small = [leg({ price: 1e-10, volatility: 1e-12, multiplier: 1e-8 })];
    expect(parseLegs(serializeLegs(small))[0]).toMatchObject({ price: 1e-10, volatility: 1e-12, multiplier: 1e-8 });
  });

  test("rejects malformed leg syntax without silently coercing blanks, dates or fractions", () => {
    for (const input of ["", "call,100,2026-12-18,1,5", "call,100,2026-12-18,1,5,25;", "call,100,2026-12-18,1,5,25,",
      "call,100,2026-02-30,1,5,25", "call,100,2026-2-20,1,5,25", "call,100,2026-12-18,0,5,25",
      "call,100,2026-12-18,1.5,5,25", "call,100,2026-12-18,1,,25", "call,0x64,2026-12-18,1,5,25",
      "call,Infinity,2026-12-18,1,5,25", "call,100,2026-12-18,1,-5,25", "call,100,2026-12-18,1,5,-25",
      "call,100,2026-12-18,1,5,25,0", "other,100,2026-12-18,1,5,25", "call,100,2026-12-18,9007199254740992,5,25"] ) {
      expect(() => parseLegs(input), input).toThrow();
    }
  });

  test("validates persisted object shapes, duplicate ids and nonfinite model controls", () => {
    const broken: unknown[] = [null, {}, { ...position(), legs: null }, { ...position(), legs: [null] },
      position([leg(), leg()]), position([leg({ quantity: 0 })]), position([leg({ expiration: Number.NaN })]),
      position([leg({ volatility: Number.POSITIVE_INFINITY })]), position([leg({ multiplier: -1 })]),
      { ...position(), rate: "0.04" }, { ...position(), spot: Number.NaN }, { ...position(), asOf: 1e100 }];
    for (const input of broken) expect(validatePosition(input as ScenarioPosition)).not.toBeNull();
    for (const controls of [{ volShift: Number.NaN }, { date: Number.POSITIVE_INFINITY }, { spotRange: 0 }]) {
      expect(() => buildScenario(position(), controls)).toThrow();
    }
    expect(() => scenarioValue(position(), -1, AS_OF)).toThrow();
    expect(() => buildScenario(position(), { spotRange: Number.MAX_VALUE })).toThrow(/precision/);
  });
});
