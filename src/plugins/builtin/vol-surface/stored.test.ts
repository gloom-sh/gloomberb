import { expect, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT } from "../options-calculator/model";
import { daysToExpiryFrom, valueOption } from "../shared/volatility";
import { buildSurfaceExpiry, buildSurfaceGrid, normalizeSurfaceSettings, withSurfaceTermSlopes, type SurfaceSnapshot } from "./model";
import { storedSurfaceMiss, storedSurfaceSnapshot } from "./stored";
import { storedSurfacePayload } from "./test-fixture";

const now = Date.UTC(2026, 8, 22, 19, 50);
const curve = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" }, { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-09-21" }];
const expiries = [Date.UTC(2026, 9, 16) / 1000, Date.UTC(2026, 11, 18) / 1000];

function chain(expiry: number, volatility: number): OptionsChain {
  const contract = (strike: number, side: "call" | "put"): OptionContract => {
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: 100, strike, daysToExpiry: daysToExpiryFrom(expiry, now),
      rate: 0.04, dividendYield: 0.01, volatility: volatility + Math.abs(strike - 100) / 400 }).price;
    return { contractSymbol: `AAPL-${side}-${strike}`, strike, currency: "USD", expiration: expiry, bid: price * 0.99, ask: price * 1.01,
      lastPrice: price, impliedVolatility: 0.3, openInterest: 20, volume: 3, lastTradeDate: now / 1000 - 600, change: 0, percentChange: 0,
      inTheMoney: side === "call" ? strike < 100 : strike > 100 };
  };
  const strikes = [70, 80, 90, 95, 100, 105, 110, 120, 130];
  return { underlyingSymbol: "AAPL", expirationDates: expiries, calls: strikes.map((strike) => contract(strike, "call")),
    puts: strikes.map((strike) => contract(strike, "put")), providerId: "test", dataSource: "live", asOf: new Date(now).toISOString() };
}

test("a stored close surface rebuilds the live grid", () => {
  const live = expiries.map((expiration, index) => buildSurfaceExpiry({ chain: chain(expiration, 0.25 + index * 0.03), expiration, spot: 100, curve, now }));
  const liveSnapshot: SurfaceSnapshot = { symbol: "AAPL", spot: 100, phase: "ready", settings: normalizeSurfaceSettings({}), catalogue: expiries,
    requested: 2, loaded: 2, failed: 0, expiries: live, failures: [], warnings: [], rateAsOf: "2026-09-21", fetchedAt: now };
  const stored = storedSurfaceSnapshot(storedSurfacePayload({ symbol: "AAPL", sessionDate: "2026-09-22", capturedAt: new Date(now).toISOString(), spot: 100,
    expiries: live, failures: ["2027-01-15: no clean quotes"] }));
  expect(stored.stored).toEqual({ sessionDate: "2026-09-22", capturedAt: new Date(now).toISOString() });
  expect(stored.catalogue).toEqual(expiries);
  expect(stored.failures).toEqual([{ expiration: null, message: "2027-01-15: no clean quotes" }]);
  expect(stored.expiries[0]!.points.length).toBe(live[0]!.points.length);
  expect(stored.expiries[0]!.parity.pairs).toEqual([]);
  for (const axis of ["forward", "delta", "strike"] as const) {
    const a = buildSurfaceGrid(liveSnapshot, { axis }), b = buildSurfaceGrid(stored, { axis });
    expect(b.rows.length).toBe(a.rows.length);
    a.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
      const other = b.rows[r]!.cells[c]!.volatility;
      if (cell.volatility == null) expect(other).toBeNull();
      else expect(other!).toBeCloseTo(cell.volatility, 4);
    }));
  }
  const residuals = stored.expiries[1]!.points.map((point) => point.fitResidual!);
  live[1]!.points.forEach((point, index) => expect(residuals[index]!).toBeCloseTo(point.fitResidual!, 4));
});

test("a capture that stored no 25-delta wings for a quoted expiry gets them from its fit, as the live surface reads them", () => {
  // Captures searched the wings far past the quotes, where a fit pinned at rho = 1 explodes, and blanked
  // the 2026-11-20 and 2026-12-18 monthlies; the fit and the quotes they kept are all the wings need.
  const live = expiries.map((expiration, index) => buildSurfaceExpiry({ chain: chain(expiration, 0.25 + index * 0.03), expiration, spot: 100, curve, now }));
  const blank = { put25: null, call25: null, atm: live[1]!.atmIV, putCallSkew: null, riskReversal: null, butterfly: null, moneynessSkew: null };
  const stored = storedSurfaceSnapshot(storedSurfacePayload({ symbol: "AAPL", sessionDate: "2026-09-22", capturedAt: new Date(now).toISOString(),
    spot: 100, expiries: live.map((expiry) => ({ ...expiry, skew: blank, termSlope: null })) }));
  stored.expiries.forEach((expiry, index) => {
    for (const key of ["put25", "call25", "atm", "riskReversal", "butterfly", "moneynessSkew"] as const) {
      expect(expiry.skew[key]!).toBeCloseTo(live[index]!.skew[key]!, 5);
    }
  });
  expect(stored.expiries[0]!.termSlope!).toBeCloseTo(withSurfaceTermSlopes(live)[0]!.termSlope!, 5);
});

test("an unknown stored format is rejected", () => {
  expect(() => storedSurfaceSnapshot({ version: 1, symbol: "AAPL", sessionDate: "2026-09-22", capturedAt: "", spot: 100, surface: { version: 2 } })).toThrow();
});

test("a long stored list names the dates nearest the miss and the span", () => {
  const dates = Array.from({ length: 40 }, (_, index) => new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10))
    .filter((date) => date !== "2026-09-15").reverse();
  expect(storedSurfaceMiss("SPY", "2026-09-15", dates)).toBe("No stored SPY close surface for 2026-09-15. Nearest stored dates: "
    + "2026-09-20, 2026-09-19, 2026-09-18, 2026-09-17, 2026-09-16, 2026-09-14, 2026-09-13, 2026-09-12, 2026-09-11, 2026-09-10; "
    + "39 stored from 2026-09-01 to 2026-10-10.");
});
