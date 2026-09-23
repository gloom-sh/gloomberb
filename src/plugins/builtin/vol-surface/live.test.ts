import { expect, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, valueOption } from "../options-calculator/model";
import type { YieldPoint } from "../yield-curve/treasury-data";
import { stableSurfaceSheet, surfaceFreshnessLabel, type SurfaceSheetAxes } from "./live";
import { buildSurfaceExpiry, buildSurfaceGrid, DEFAULT_SURFACE_SETTINGS, SURFACE_3D_DELTAS, withSurfaceTermSlopes,
  type SurfaceSnapshot } from "./model";
import { volatilitySurfaceInput } from "./raster";

const now = Date.parse("2026-09-23T15:00:00Z");
const curve: YieldPoint[] = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-22" },
  { maturity: "3Y", maturityYears: 3, yield: 4, asOf: "2026-09-22" }];
const expirations = [30, 60, 95, 190, 370, 740].map((days) => Date.UTC(2026, 8, 23 + days) / 1000);

function chain(expiration: number, quoted: boolean): OptionsChain {
  const days = daysToExpiryFrom(expiration, now);
  const contract = (strike: number, side: "call" | "put"): OptionContract => {
    const volatility = 0.25 + 0.4 * Math.log(strike / 100) ** 2;
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: 100, strike, daysToExpiry: days,
      volatility, rate: 0.04, dividendYield: 0 }).price;
    return { contractSymbol: `T-${expiration}-${side}-${strike}`, strike, expiration, currency: "USD", lastPrice: price,
      bid: quoted ? price * 0.995 : 0, ask: quoted ? price * 1.005 : 0, impliedVolatility: volatility, openInterest: 100,
      volume: 1, lastTradeDate: now / 1000 - 60, change: 0, percentChange: 0, inTheMoney: false };
  };
  const strikes = Array.from({ length: 13 }, (_, index) => 70 + index * 5);
  return { underlyingSymbol: "T", expirationDates: expirations, asOf: new Date(now).toISOString(), dataSource: "live",
    calls: strikes.map((strike) => contract(strike, "call")), puts: strikes.map((strike) => contract(strike, "put")) };
}

function snapshot(spot: number, unquoted: number[] = [], requested = expirations.length): SurfaceSnapshot {
  const expiries = withSurfaceTermSlopes(expirations.map((expiration) => buildSurfaceExpiry({
    chain: chain(expiration, !unquoted.includes(expiration)), expiration, spot, curve, now })));
  return { symbol: "T", spot, phase: "ready", settings: DEFAULT_SURFACE_SETTINGS, catalogue: expirations, requested,
    loaded: expirations.length, failed: 0, expiries, failures: [], warnings: [], rateAsOf: null, fetchedAt: now };
}

function deltaGrid(sheet: ReturnType<typeof stableSurfaceSheet<SurfaceSnapshot>>) {
  return buildSurfaceGrid(sheet.snapshot, sheet.tenors
    ? { axis: "delta", tenors: "fixed", fixedTenors: sheet.tenors, coordinates: SURFACE_3D_DELTAS }
    : { axis: "delta", tenors: "listed", coordinates: SURFACE_3D_DELTAS });
}

test("a reload over the same expiries keeps the sheet's rows and columns so it can morph", () => {
  const first = stableSurfaceSheet(snapshot(100), null);
  expect(first.axes).not.toBeNull();
  const firstGrid = deltaGrid(first);
  expect(firstGrid.tenors.at(-1)).toBe(2);

  // The longest slice loses its quotes and the spot moves: fitted from
  // scratch, the sheet would stop at one year and change shape.
  const reloaded = snapshot(101, [expirations.at(-1)!]);
  expect(stableSurfaceSheet(reloaded, null).tenors!.at(-1)!.label).toBe("1Y");
  const kept = stableSurfaceSheet(reloaded, first.axes);
  const keptGrid = deltaGrid(kept);
  expect(keptGrid.tenors).toEqual(firstGrid.tenors);
  expect(keptGrid.moneyness).toEqual(firstGrid.moneyness);
  expect(keptGrid.volatilities.map((row) => row.length)).toEqual(firstGrid.volatilities.map((row) => row.length));
  expect(keptGrid.volatilities).not.toEqual(firstGrid.volatilities);

  // Another expiry set, or a load still in progress, chooses afresh and pins nothing.
  const other: SurfaceSheetAxes = { ...first.axes!, identity: "T|1,2,3" };
  expect(stableSurfaceSheet(reloaded, other).tenors!.at(-1)!.label).toBe("1Y");
  expect(stableSurfaceSheet(snapshot(100, [], expirations.length + 1), first.axes).axes).toBeNull();
});

test("a smile whose fit falls back on reload leaves the sheet instead of drawing a hole", () => {
  const first = stableSurfaceSheet(snapshot(100), null);
  const reloaded = snapshot(100);
  const fellBack = { ...reloaded, expiries: reloaded.expiries.map((entry, index) => index === 2
    ? { ...entry, fit: { ...entry.fit!, method: "monotone-cubic" as const } } : entry) };
  const kept = stableSurfaceSheet(fellBack, first.axes);
  expect(kept.snapshot.expiries.map((entry) => entry.expiration)).not.toContain(expirations[2]);
  expect(kept.omitted.map((entry) => entry.expiration)).toEqual([expirations[2]!]);
  // The delta sheet keeps its constant maturities, interpolated across the gap.
  expect(deltaGrid(kept).tenors).toEqual(deltaGrid(first).tenors);
});

test("a reloaded sheet inside the drawn range keeps the box and colour scale", () => {
  const grid = (lift: number) => ({ tenors: [0.1, 0.5], moneyness: [0.9, 1, 1.1],
    volatilities: [[0.3 + lift, 0.25 + lift, 0.27 + lift], [0.29 + lift, 0.26 + lift, 0.28 + lift]] });
  const drawn = volatilitySurfaceInput(grid(0), null);
  const nudged = volatilitySurfaceInput(grid(0.004), null, drawn);
  expect([nudged.zMin, nudged.zMax]).toEqual([drawn.zMin, drawn.zMax]);
  const jumped = volatilitySurfaceInput(grid(0.2), null, drawn);
  expect(jumped.zMax).toBeGreaterThan(drawn.zMax);
});

test("the footer names the quotes' basis and never calls a delayed or mixed surface real-time", () => {
  const live = snapshot(100);
  expect(surfaceFreshnessLabel(live, 15)).toBe("real-time · as of 15:00:00 UTC");
  const mixed = { ...live, expiries: live.expiries.map((entry, index) => index ? entry : { ...entry, dataSource: "delayed" as const, delayMinutes: 15 }) };
  expect(surfaceFreshnessLabel(mixed, 15)).toStartWith("mixed real-time and delayed");
  const delayed = { ...live, expiries: live.expiries.map((entry) => ({ ...entry, dataSource: "delayed" as const, delayMinutes: 20 })) };
  expect(surfaceFreshnessLabel(delayed, 15)).toStartWith("20m delayed");
});
