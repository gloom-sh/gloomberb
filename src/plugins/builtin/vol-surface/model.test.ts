import { describe, expect, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, valueOption } from "../options-calculator/model";
import { optionDelta } from "../shared/volatility";
import {
  buildSurfaceExpiry, buildSurfaceGrid, cleanSurfaceQuotes, DEFAULT_SURFACE_SETTINGS,
  evaluateSurfaceSmile, surfaceSheetSnapshot, surfaceTreasuryRate, windowSurfaceGrid, type SurfaceSnapshot,
} from "./model";

const now = Date.UTC(2026, 8, 22, 14);
const expiration = Date.UTC(2026, 11, 18) / 1000;
const curve = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" },
  { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-09-21" }];

function chain(expiry = expiration, volatility = 0.3, strikes = [70, 80, 90, 95, 100, 105, 110, 120, 130]): OptionsChain {
  const contract = (strike: number, side: "call" | "put"): OptionContract => {
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: 100, strike,
      daysToExpiry: daysToExpiryFrom(expiry, now), rate: 0.04, dividendYield: 0.01, volatility }).price;
    return { contractSymbol: `${side}-${strike}-${expiry}`, strike, currency: "USD", expiration: expiry,
      bid: price * 0.99, ask: price * 1.01, lastPrice: price * 2, impliedVolatility: 0.44,
      openInterest: 10, volume: 2, lastTradeDate: now / 1000 - 1000,
      change: 0, percentChange: 0, inTheMoney: side === "call" ? strike < 100 : strike > 100 };
  };
  return { underlyingSymbol: "AAPL", expirationDates: [expiry], calls: strikes.map((strike) => contract(strike, "call")),
    puts: strikes.map((strike) => contract(strike, "put")), providerId: "test", dataSource: "delayed", delayMinutes: 15,
    asOf: "2026-09-22T13:45:00Z" };
}

describe("surface cleaning and midpoint model", () => {
  test("closing quotes are valued at the time they were observed, not at the current clock", () => {
    // Priced at 30% at the quote time; read 16 hours later, before the next open.
    const quoted = { ...chain(), asOf: new Date(now).toISOString() };
    const result = buildSurfaceExpiry({ chain: quoted, expiration, spot: 100, curve, now: now + 16 * 3_600_000 });
    expect(result.years).toBeCloseTo(daysToExpiryFrom(expiration, now) / 365, 10);
    expect(result.atmIV).toBeCloseTo(0.3, 5);
  });

  test("keeps executable OTM quotes, recovers the parity forward and uses the shared IV solver", () => {
    const result = buildSurfaceExpiry({ chain: chain(), expiration, spot: 100, curve, now });
    const years = daysToExpiryFrom(expiration, now) / 365;
    expect(result.state).toBe("ready");
    expect(result.rate).toBeCloseTo(0.04, 12);
    expect(result.forward).toBeCloseTo(100 * Math.exp(0.03 * years), 6);
    expect(result.dividendYield).toBeCloseTo(0.01, 8);
    expect(result.atmIV).toBeCloseTo(0.3, 5);
    expect(result.points.length).toBeGreaterThan(5);
    for (const point of result.points) {
      expect(point.side === "call" ? point.strike >= result.forward! : point.strike < result.forward!).toBe(true);
      expect(point.volatility).toBeCloseTo(0.3, 4);
      expect(point.providerIV).toBe(0.44);
      expect(point.price).toBeCloseTo((point.contract.bid + point.contract.ask) / 2, 10);
    }
    expect(result.expectedMove.sigma).toBeCloseTo(100 * 0.3 * Math.sqrt(years), 4);
    expect(result.asOf).toBe("2026-09-22T13:45:00Z");
    expect(result.rateAsOf).toEqual(["2026-09-21"]);
  });

  test("provider mode never converts zero-bid placeholders or last trades into observations", () => {
    const input = chain();
    input.calls = input.calls.map((contract) => ({ ...contract, bid: 0, ask: 0, impliedVolatility: 0.12500875 }));
    input.puts = input.puts.map((contract) => ({ ...contract, bid: 0, ask: 0, impliedVolatility: 0.500005 }));
    for (const ivSource of ["recomputed", "provider"] as const) {
      const result = buildSurfaceExpiry({ chain: input, expiration, spot: 100, curve, now, settings: { ivSource } });
      expect(result.points).toHaveLength(0);
      expect(result.fit).toBeNull();
      expect(result.forward).toBeNull();
      expect(result.filterCounts["zero-bid"]).toBe(18);
    }
  });

  test("does not fit a smile whose near-the-money quotes are all missing", () => {
    // Yahoo's post-close LEAPS: the wings keep quotes while every strike near
    // the forward is zero-bid. A fit bridging the wings invented a 12% ATM.
    const input = chain(expiration, 0.3, Array.from({ length: 33 }, (_, index) => 60 + index * 2.5));
    const unquoted = (contract: OptionContract) => contract.strike > 80 && contract.strike < 120 ? { ...contract, bid: 0, ask: 0 } : contract;
    const gapped = { ...input, calls: input.calls.map(unquoted), puts: input.puts.map(unquoted) };
    const result = buildSurfaceExpiry({ chain: gapped, expiration, spot: 100, curve, now });
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.fit).toBeNull();
    expect(result.atmIV).toBeNull();
    expect(result.state).not.toBe("ready");
  });

  test("records cleaning reasons, rejects mismatched expiries and prefers fresh duplicate quotes", () => {
    const template = chain().calls[4]!;
    const quote = (strike: number, patch: Partial<OptionContract> = {}): OptionContract => ({ ...template, strike, bid: 2, ask: 2.1, ...patch });
    const old = now / 1000 - 30 * 86400;
    const input: OptionsChain = { underlyingSymbol: "AAPL", expirationDates: [expiration], puts: [], calls: [
      quote(1, { bid: 0 }), quote(2, { bid: 3, ask: 2 }), quote(3, { bid: 1, ask: 4 }),
      quote(4, { openInterest: 0 }), quote(5, { openInterest: undefined }), quote(6, { expiration: expiration + 86400 }),
      quote(7, { lastTradeDate: old }), quote(7), quote(8, { lastTradeDate: old }), quote(9), quote(9, { ask: 2.05 }),
    ] };
    const result = cleanSurfaceQuotes(input, expiration, DEFAULT_SURFACE_SETTINGS, now);
    expect(result.calls.map((contract) => contract.strike)).toEqual([7, 8, 9]);
    expect(result.calls.at(-1)!.ask).toBe(2.05);
    expect(result.filterCounts["zero-bid"]).toBe(1);
    expect(result.filterCounts.crossed).toBe(1);
    expect(result.filterCounts["wide-spread"]).toBe(1);
    expect(result.filterCounts["no-interest"]).toBe(2);
    expect(result.filterCounts["expiry-mismatch"]).toBe(1);
    expect(result.filterCounts["stale-duplicate"]).toBe(1);
    expect(result.filterCounts.duplicate).toBe(1);
  });

  test("keeps quote side and provider comparison distinct and exposes absent rates/parity", () => {
    const input = chain();
    const mid = buildSurfaceExpiry({ chain: input, expiration, spot: 100, curve, now });
    const bid = buildSurfaceExpiry({ chain: input, expiration, spot: 100, curve, now, settings: { priceSide: "bid" } });
    const ask = buildSurfaceExpiry({ chain: input, expiration, spot: 100, curve, now, settings: { priceSide: "ask" } });
    expect(bid.atmIV!).toBeLessThan(mid.atmIV!);
    expect(ask.atmIV!).toBeGreaterThan(mid.atmIV!);
    const provider = buildSurfaceExpiry({ chain: input, expiration, spot: 100, curve, now, settings: { ivSource: "provider" } });
    expect(provider.atmIV).toBeCloseTo(0.44, 8);
    expect(buildSurfaceExpiry({ chain: input, expiration, spot: 100, curve: [], now }).rate).toBeNull();
    const unpaired = buildSurfaceExpiry({ chain: { ...input, puts: [] }, expiration, spot: 100, curve, now });
    expect(unpaired.fit).toBeNull();
    expect(unpaired.parity.method).toBe("unavailable");
  });

  test("does not extrapolate old far-wing observations into a near-ATM surface", () => {
    const result = buildSurfaceExpiry({ chain: chain(), expiration, spot: 100, curve, now });
    result.points = result.points.filter((point) => point.strike >= 110);
    expect(evaluateSurfaceSmile(result, 100)).toBeNull();
    expect(evaluateSurfaceSmile(result, 115)).not.toBeNull();
  });

  test("preserves quoted ATM straddle when Treasury is unavailable without inventing modeled IV", () => {
    const result = buildSurfaceExpiry({ chain: chain(), expiration, spot: 100, curve: [], now });
    const complete = buildSurfaceExpiry({ chain: chain(), expiration, spot: 100, curve, now });
    expect(result.expectedMove.straddle).toBe(complete.expectedMove.straddle);
    expect(result.expectedMove.straddle).toBeGreaterThan(0);
    expect(result.expectedMove.sigma).toBeNull();
    expect(result.atmIV).toBeNull();
    expect(result.fit).toBeNull();
    expect(result.warnings).toContain("Treasury rate unavailable");
  });
});

test("Treasury rates use percent conversion, explicit boundaries, dates and valid negative yields", () => {
  const points = [{ maturity: "1M", maturityYears: 1 / 12, yield: 3, asOf: "2026-09-21" },
    { maturity: "1Y", maturityYears: 1, yield: 5, asOf: "2026-09-18", stale: true }];
  const middle = surfaceTreasuryRate(points, (1 / 12 + 1) / 2);
  expect(middle.rate).toBeCloseTo(0.04, 12);
  expect(middle.method).toBe("treasury-interpolated");
  expect(middle.asOf).toEqual(["2026-09-21", "2026-09-18"]);
  expect(middle.warnings).toHaveLength(2);
  expect(surfaceTreasuryRate(points, 7 / 365).method).toBe("treasury-boundary");
  expect(surfaceTreasuryRate(points, 7 / 365).rate).toBe(0.03);
  expect(surfaceTreasuryRate([{ maturity: "1Y", maturityYears: 1, yield: -0.5 }], 1).rate).toBe(-0.005);
  expect(surfaceTreasuryRate([{ maturity: "1Y", maturityYears: 1, yield: null }], 1).rate).toBeNull();
});

describe("surface grids", () => {
  function snapshot(): SurfaceSnapshot {
    const expirations = [Date.UTC(2027, 0, 15) / 1000, Date.UTC(2027, 5, 18) / 1000];
    return { symbol: "AAPL", spot: 100, phase: "ready", settings: DEFAULT_SURFACE_SETTINGS, catalogue: expirations,
      requested: 2, loaded: 2, failed: 0, failures: [], warnings: [], rateAsOf: "2026-09-21", fetchedAt: now,
      expiries: expirations.map((expiry, index) => buildSurfaceExpiry({ chain: chain(expiry, index ? 0.4 : 0.3),
        expiration: expiry, spot: 100, curve, now })) };
  }

  test("preserves missing observed strike coverage and keeps raster rows aligned", () => {
    const data = snapshot();
    const grid = buildSurfaceGrid(data, { coordinates: [0.5, 0.9, 1, 1.1, 2] });
    expect(grid.tenors).toEqual(data.expiries.map((expiry) => expiry.years));
    expect(grid.volatilities[0]![0]).toBeNull();
    expect(grid.volatilities[0]![4]).toBeNull();
    expect(grid.rows[0]!.cells[2]!.strike).toBe(100);
    expect(grid.rows[0]!.cells[2]!.point?.contract.contractSymbol).toContain("100");
    expect(grid.volatilities[0]![2]).toBeCloseTo(0.3, 5);
    expect(grid.volatilities[1]![2]).toBeCloseTo(0.4, 5);
  });

  test("the sigma window widens with tenor and leaves rows without an ATM IV alone", () => {
    const data = snapshot();
    const coordinates = Array.from({ length: 41 }, (_, i) => 0.8 + i * 0.01);
    const grid = buildSurfaceGrid(data, { axis: "forward", coordinates });
    const windowed = windowSurfaceGrid(grid, data, 1);
    const count = (row: (number | null)[]) => row.filter((value) => value != null).length;
    // One standard deviation at 30% and 40% IV: roughly +/-17% and +/-35% of the forward.
    expect(count(windowed.volatilities[0]!)).toBeLessThan(count(grid.volatilities[0]!));
    expect(count(windowed.volatilities[1]!)).toBeGreaterThan(count(windowed.volatilities[0]!));
    expect(windowed.volatilities[0]![20]).toBe(grid.volatilities[0]![20]);
    expect(windowed.rows[0]!.cells[0]!.strike).toBe(grid.rows[0]!.cells[0]!.strike);
    const blind = { ...data, expiries: data.expiries.map((expiry) => ({ ...expiry, atmIV: null })) };
    expect(windowSurfaceGrid(buildSurfaceGrid(blind, { axis: "forward", coordinates }), blind).volatilities)
      .toEqual(buildSurfaceGrid(blind, { axis: "forward", coordinates }).volatilities);
  });

  test("fixed tenors interpolate total variance at common forward moneyness", () => {
    const data = snapshot();
    const grid = buildSurfaceGrid(data, { axis: "forward", tenors: "fixed", coordinates: [1] });
    const row = grid.rows.find((value) => value.label === "6M")!;
    const first = data.expiries[0]!, last = data.expiries[1]!;
    const weight = (row.years - first.years) / (last.years - first.years);
    const expected = Math.sqrt(((1 - weight) * 0.3 ** 2 * first.years + weight * 0.4 ** 2 * last.years) / row.years);
    expect(row.cells[0]!.volatility).toBeCloseTo(expected, 5);
    expect(row.interpolated).toBe(true);
    expect(row.extrapolated).toBe(false);
    expect(row.rate).toBeCloseTo(0.04, 12);
    expect(row.dividendYield).toBeCloseTo(0.01, 8);
    expect(row.forward).toBeCloseTo(data.spot * Math.exp((row.rate! - row.dividendYield!) * row.years), 10);
    expect(grid.rows[0]!.extrapolated).toBe(true);
  });

  test("delta coordinates solve against each displayed tenor and fitted smile", () => {
    const data = snapshot();
    for (const tenors of ["listed", "fixed"] as const) {
      const grid = buildSurfaceGrid(data, { axis: "delta", tenors, coordinates: [-0.25, 0, 0.25] });
      const row = tenors === "fixed" ? grid.rows.find((value) => value.label === "6M")! : grid.rows[0]!;
      for (const [index, side] of [[0, "put"], [2, "call"]] as const) {
        const cell = row.cells[index]!;
        expect(cell.strike).not.toBeNull();
        expect(optionDelta({ spot: 100, years: row.years, rate: 0.04, dividendYield: 0.01,
          volatility: cell.volatility! }, cell.strike!, side)).toBeCloseTo(index ? 0.25 : -0.25, 6);
      }
    }
  });
});

test("the 3D sheet drops interpolation-fallback expiries only when four SVI slices remain", () => {
  const slice = (expiration: number, method: "svi" | "monotone-cubic") => ({ expiration, fit: { method } }) as unknown as SurfaceSnapshot["expiries"][number];
  const snapshot = (methods: ("svi" | "monotone-cubic")[]) => ({ expiries: methods.map((method, index) => slice(index + 1, method)) }) as unknown as SurfaceSnapshot;
  const mixed = surfaceSheetSnapshot(snapshot(["svi", "svi", "svi", "svi", "monotone-cubic"]));
  expect(mixed.snapshot.expiries.map((entry) => entry.expiration)).toEqual([1, 2, 3, 4]);
  expect(mixed.omitted.map((entry) => entry.expiration)).toEqual([5]);
  const thin = surfaceSheetSnapshot(snapshot(["svi", "svi", "monotone-cubic"]));
  expect(thin.snapshot.expiries).toHaveLength(3);
  expect(thin.omitted).toEqual([]);
});

test("the delta axis centres ATM on the delta-neutral straddle strike, between 45P and 45C", () => {
  const expiry = buildSurfaceExpiry({ chain: chain(), expiration, spot: 100, curve, now });
  const snapshot = { symbol: "AAPL", spot: 100, phase: "ready", settings: DEFAULT_SURFACE_SETTINGS, catalogue: [expiration], requested: 1, loaded: 1,
    failed: 0, expiries: [expiry], failures: [], warnings: [], rateAsOf: null, fetchedAt: now } as SurfaceSnapshot;
  const row = buildSurfaceGrid(snapshot, { axis: "delta", coordinates: [-0.45, 0, 0.45] }).rows[0]!;
  const [put45, atm, call45] = row.cells.map((cell) => cell.strike!);
  expect(atm).toBeCloseTo(expiry.forward! * Math.exp(0.3 * 0.3 * expiry.years / 2), 1);
  expect(put45).toBeLessThan(atm);
  expect(call45).toBeGreaterThan(atm);
});
