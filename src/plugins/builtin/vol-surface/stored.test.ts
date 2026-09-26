import { expect, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, valueOption } from "../options-calculator/model";
import { buildSurfaceExpiry, buildSurfaceGrid, normalizeSurfaceSettings, type SurfaceExpiry, type SurfaceSnapshot } from "./model";
import { storedSurfaceSnapshot } from "./stored";

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

/** Gloom Cloud's compaction of a captured surface, including its rounding. */
const round = (value: number | null | undefined, digits: number) => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const compact = (expiry: SurfaceExpiry) => ({
  expiration: expiry.expiration, years: round(expiry.years, 8), rate: round(expiry.rate, 6), rateMethod: expiry.rateMethod,
  rateAsOf: expiry.rateAsOf, forward: round(expiry.forward, 4), dividendYield: round(expiry.dividendYield, 6),
  atmIV: round(expiry.atmIV, 6), termSlope: round(expiry.termSlope, 6), skew: expiry.skew, expectedMove: expiry.expectedMove,
  fit: expiry.fit, filterCounts: expiry.filterCounts, warnings: expiry.warnings, asOf: expiry.asOf,
  points: expiry.points.map((point) => [point.strike, point.side === "call" ? 1 : 0, round(point.volatility, 6), round(point.mid, 4),
    round(point.contract.bid, 4), round(point.contract.ask, 4), point.openInterest, point.contract.contractSymbol]),
});

test("a stored close surface rebuilds the live grid", () => {
  const live = expiries.map((expiration, index) => buildSurfaceExpiry({ chain: chain(expiration, 0.25 + index * 0.03), expiration, spot: 100, curve, now }));
  const liveSnapshot: SurfaceSnapshot = { symbol: "AAPL", spot: 100, phase: "ready", settings: normalizeSurfaceSettings({}), catalogue: expiries,
    requested: 2, loaded: 2, failed: 0, expiries: live, failures: [], warnings: [], rateAsOf: "2026-09-21", fetchedAt: now };
  const stored = storedSurfaceSnapshot({ version: 1, symbol: "AAPL", sessionDate: "2026-09-22", capturedAt: new Date(now).toISOString(), spot: 100,
    surface: { version: 1, symbol: "AAPL", spot: 100, spotAsOf: new Date(now).toISOString(), capturedAt: new Date(now).toISOString(), source: null,
      expiries: JSON.parse(JSON.stringify(live.map(compact))), failures: ["2027-01-15: no clean quotes"] } });
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

test("an unknown stored format is rejected", () => {
  expect(() => storedSurfaceSnapshot({ version: 1, symbol: "AAPL", sessionDate: "2026-09-22", capturedAt: "", spot: 100, surface: { version: 2 } })).toThrow();
});
