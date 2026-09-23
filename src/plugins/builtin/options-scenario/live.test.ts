import { expect, test } from "bun:test";
import type { OptionsChain } from "../../../types/financials";
import { liveScenarioPosition, scenarioLegContractSymbol } from "./live";
import { buildScenario, type ScenarioPosition } from "./model";

const asOf = Date.parse("2026-09-23T14:00:00Z");
const expiration = Date.UTC(2026, 9, 16) / 1000;
const position: ScenarioPosition = { symbol: "AAPL", currency: "USD", spot: 100, rate: 0.04, dividendYield: 0, asOf,
  legs: [{ id: "long", side: "call", quantity: 2, strike: 105, expiration, price: 1.5, volatility: 0.25, multiplier: 100 },
    { id: "short", side: "put", quantity: -1, strike: 95, expiration, price: 1.2, volatility: 0.3, multiplier: 100 }] };

test("marking to the market values each quoted leg at its live midpoint and keeps entry prices", () => {
  const now = asOf + 90 * 60_000;
  const live = liveScenarioPosition(position, 102, now, new Map([["long", 2.4]]));
  expect(live).toMatchObject({ spot: 102, asOf: now });
  expect(live.legs.map((leg) => leg.price)).toEqual([1.5, 1.2]);
  // The unquoted leg keeps its volatility; the quoted one reproduces its midpoint.
  expect(live.legs[1]).toBe(position.legs[1]!);
  const scenario = buildScenario({ ...live, legs: [live.legs[0]!] });
  expect(scenario.valuation.price / 200).toBeCloseTo(2.4, 6);
  expect(scenario.valuation.pnl).toBeCloseTo((2.4 - 1.5) * 200, 4);
  // An origin past a leg's expiry is not taken; the position's own origin stays.
  const late = liveScenarioPosition(position, 102, Date.UTC(2026, 9, 20), new Map());
  expect(late.asOf).toBe(asOf);
});

test("a leg resolves to the chain's own listed symbol, else to its OCC form from its current terms", () => {
  const leg = position.legs[0]!;
  expect(scenarioLegContractSymbol("AAPL", leg)).toBe("AAPL261016C00105000");
  expect(scenarioLegContractSymbol("^SPX", { ...leg, strike: 5_812.5 })).toBe("SPX261016C05812500");
  const chain = { underlyingSymbol: "SPX", expirationDates: [expiration], puts: [],
    calls: [{ contractSymbol: "SPXW261016C05812500", strike: 5_812.5, expiration }] } as unknown as OptionsChain;
  expect(scenarioLegContractSymbol("^SPX", { ...leg, strike: 5_812.5 }, chain)).toBe("SPXW261016C05812500");
});
