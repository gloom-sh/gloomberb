import { describe, expect, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import {
  applyStrikeWindow,
  chainDeltasByStrike,
  normalizeStrikeWindowOption,
  parseDeltaBand,
  resolveStrikeWindow,
  strikeWindowNotice,
  type StrikeDeltas,
} from "./strike-window";

const STRIKES = Array.from({ length: 21 }, (_, index) => 100 + index * 10);

describe("strike window settings", () => {
  test("reads a stored or typed window, and every strike for anything else, as old layouts have none", () => {
    expect(resolveStrikeWindow(undefined)).toEqual({ kind: "all" });
    expect(resolveStrikeWindow("all")).toEqual({ kind: "all" });
    expect(resolveStrikeWindow(10)).toEqual({ kind: "around", count: 10 });
    expect(resolveStrikeWindow("0.70-0.90")).toEqual({ kind: "delta", min: 0.7, max: 0.9 });
    expect(resolveStrikeWindow("nonsense")).toEqual({ kind: "all" });
    expect(resolveStrikeWindow({ kind: "around" })).toEqual({ kind: "all" });
  });

  test("takes a delta band the ways it is written, as absolute deltas in order", () => {
    for (const typed of ["0.70-0.90", ".7-.9", "70-90", "0.9-0.7", "-0.9--0.7", "Δ .70 - .90", "0.7,0.9"]) {
      expect(parseDeltaBand(typed)).toEqual({ min: 0.7, max: 0.9 });
    }
    for (const typed of ["0.7", "1.2-150", "a-b", ""]) expect(parseDeltaBand(typed)).toBeNull();
  });

  test("--strikes stores the canonical text and names what it takes when it cannot read one", () => {
    expect(normalizeStrikeWindowOption("ALL")).toBe("all");
    expect(normalizeStrikeWindowOption("15")).toBe("15");
    expect(normalizeStrikeWindowOption(".7-.9")).toBe("0.70-0.90");
    for (const bad of ["0", "201", "wide", "0.7"]) {
      expect(() => normalizeStrikeWindowOption(bad)).toThrow("Use all, a count of strikes either side of the money");
    }
  });
});

describe("applyStrikeWindow", () => {
  test("keeps a count either side of the strike nearest the money, short at the ends of the chain", () => {
    expect(applyStrikeWindow(STRIKES, { kind: "around", count: 2 }, { center: 151 }).strikes).toEqual([130, 140, 150, 160, 170]);
    expect(applyStrikeWindow(STRIKES, { kind: "around", count: 2 }, { center: 96 }).strikes).toEqual([100, 110, 120]);
    // The held contract stays listed however far from the money it is.
    expect(applyStrikeWindow(STRIKES, { kind: "around", count: 1 }, { center: 200, keep: 100 }).strikes).toEqual([100, 190, 200, 210]);
  });

  test("keeps the strikes whose call or put delta is in the band, edges included as displayed", () => {
    const deltas: StrikeDeltas = new Map([
      [100, { call: 0.95, put: 0.05 }],
      [110, { call: 0.9004, put: 0.1 }],
      [120, { call: 0.8 }],
      // A strike with no quote on either side has no delta to judge.
      [130, {}],
      [140, { call: 0.6996, put: 0.3 }],
      [150, { call: 0.5, put: 0.5 }],
      [190, { call: 0.2, put: 0.8 }],
    ]);
    const result = applyStrikeWindow(STRIKES, { kind: "delta", min: 0.7, max: 0.9 }, { deltas });
    expect(result).toEqual({ strikes: [110, 120, 140, 190], total: 21, fallback: null });
  });

  test("lists every strike, and says why, when there is no price to centre on or no delta to read", () => {
    expect(applyStrikeWindow(STRIKES, { kind: "around", count: 5 }, { center: null }))
      .toMatchObject({ strikes: STRIKES, fallback: "no-price" });
    expect(applyStrikeWindow(STRIKES, { kind: "delta", min: 0.7, max: 0.9 }, { deltas: new Map() }))
      .toMatchObject({ strikes: STRIKES, fallback: "no-delta" });
  });

  test("a report says how many strikes are listed of how many the expiry has", () => {
    const around = applyStrikeWindow(STRIKES, { kind: "around", count: 2 }, { center: 151 });
    expect(strikeWindowNotice({ kind: "around", count: 2 }, around))
      .toBe("5 of 21 strikes, 2 either side of the money (130 to 170). --strikes all lists every strike.");
    expect(strikeWindowNotice({ kind: "all" }, applyStrikeWindow(STRIKES, { kind: "all" }))).toBe("All 21 strikes (100 to 300).");
    expect(strikeWindowNotice({ kind: "delta", min: 0.7, max: 0.9 }, { strikes: [], total: 21, fallback: null }))
      .toBe("0 of 21 strikes with a call or put delta of 0.70 to 0.90. --strikes all lists every strike.");
  });
});

function contract(strike: number, bid: number, ask: number): OptionContract {
  return {
    contractSymbol: `X${strike}`, strike, currency: "USD", lastPrice: 0, change: 0, percentChange: 0,
    bid, ask, impliedVolatility: 0, inTheMoney: false, expiration: Date.UTC(2028, 0, 21) / 1000, lastTradeDate: 0,
  };
}

test("chainDeltasByStrike reads deltas only where a side has a two-sided quote, and none without a spot", () => {
  const chain: OptionsChain = {
    underlyingSymbol: "X",
    expirationDates: [Date.UTC(2028, 0, 21) / 1000],
    calls: [contract(80, 28, 29), contract(100, 15, 16), contract(120, 0, 0.5)],
    puts: [contract(80, 4, 4.5), contract(100, 11, 12), contract(120, 25, 26)],
  };
  const deltas = chainDeltasByStrike(chain, 100, 0, Date.parse("2026-10-09T20:00:00Z"));
  expect(deltas.get(80)!.call!).toBeGreaterThan(deltas.get(100)!.call!);
  expect(deltas.get(100)!.put!).toBeGreaterThan(0);
  // The 120 call has a zero bid: no midpoint, so no delta on that side.
  expect(deltas.get(120)!.call).toBeUndefined();
  expect(deltas.get(120)!.put!).toBeGreaterThan(deltas.get(100)!.put!);
  expect(chainDeltasByStrike(chain, undefined, 0).size).toBe(0);
});
