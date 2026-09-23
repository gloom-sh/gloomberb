import { describe, expect, test } from "bun:test";
import { DEFAULT_OPTION_CALC_DRAFT, solveImpliedVolatility, valueOption } from "../../options-calculator/model";
import { expectedMove, extractImpliedForward, forwardFromCarry, logForwardMoneyness, optionDelta,
  optionMid, smileSkew, strikeForDelta, strikeFromLogMoneyness, volatilityTermSlope } from "./options";

const input = { spot: 100, years: 0.5, rate: 0.04, dividendYield: 0.015, volatility: 0.3 };
function quote(strike: number, side: "call" | "put") {
  const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, ...input, strike, side, daysToExpiry: input.years * 365 }).price;
  return { strike, bid: price - 0.01, ask: price + 0.01, contractSymbol: `${side}${strike}` };
}

describe("delta and forward conversions", () => {
  test("inverts signed call/put deltas with dividend carry and changing scale", () => {
    for (const spot of [0.001, 100, 100_000]) {
      for (const side of ["call", "put"] as const) {
        for (const absolute of [0.1, 0.25, 0.8]) {
          const target = side === "call" ? absolute : -absolute;
          const strike = strikeForDelta({ ...input, spot }, target, side)!;
          expect(optionDelta({ ...input, spot }, strike, side)).toBeCloseTo(target, 7);
        }
      }
    }
  });
  test("rejects targets beyond dividend-discounted delta and expiry boundaries", () => {
    expect(strikeForDelta({ ...input, dividendYield: 2 }, 0.5, "call")).toBeNull();
    expect(strikeForDelta(input, 0.25, "put")).toBeNull();
    expect(strikeForDelta(input, 0, "call")).toBeNull();
    expect(strikeForDelta({ ...input, years: 0 }, 0.25, "call")).toBeNull();
    expect(strikeForDelta({ ...input, volatility: NaN }, 0.25, "call")).toBeNull();
  });
  test("round trips forward log-moneyness without overflowing ratios", () => {
    const forward = forwardFromCarry(100, 0.5, 0.04, 0.015)!;
    expect(forward).toBeCloseTo(101.257845, 5);
    expect(strikeFromLogMoneyness(logForwardMoneyness(120, forward)!, forward)).toBeCloseTo(120, 9);
    expect(logForwardMoneyness(1e300, 1e-300)).toBeCloseTo(600 * Math.log(10), 8);
    expect(strikeFromLogMoneyness(1000, 100)).toBeNull();
    expect(forwardFromCarry(100, -1, 0.04)).toBeNull();
  });
});

describe("parity forward", () => {
  test("recovers carry from paired bracketing quotes and preserves contributing contracts", () => {
    const strikes = [85, 90, 95, 100, 105, 110, 115];
    const result = extractImpliedForward(strikes.map((k) => quote(k, "call")), strikes.map((k) => quote(k, "put")), 100, 0.5, 0.04);
    expect(result.forward).toBeCloseTo(forwardFromCarry(100, 0.5, 0.04, 0.015)!, 6);
    expect(result.dividendYield).toBeCloseTo(0.015, 6);
    expect(result.pairs.map((pair) => pair.strike)).toEqual([95, 100, 105, 110]);
    expect(result.pairs[0]?.call).toBe("call95");
    expect(result.warnings).toEqual([]);
  });
  test("missing side never invents a measured forward, one valid pair is marked partial", () => {
    expect(extractImpliedForward([quote(100, "call")], [], 100, 0.5, 0.04).forward).toBeNull();
    const one = extractImpliedForward([quote(100, "call")], [quote(100, "put")], 100, 0.5, 0.04);
    expect(one.forward).not.toBeNull();
    expect(one.warnings).toContain("Parity strikes do not bracket spot");
    expect(optionMid({ bid: 0, ask: 2 })).toBeNull();
    expect(optionMid({ bid: 2, ask: 1 })).toBeNull();
    expect(extractImpliedForward([quote(100, "call")], [quote(100, "put")], 100, 0, 0.04).forward).toBeNull();
  });
  test("median resists one corrupt pair and warns about disjoint quote intervals", () => {
    const strikes = [95, 100, 105];
    const calls = strikes.map((k) => quote(k, "call"));
    calls[0] = { ...calls[0]!, bid: 30, ask: 30.02 };
    const result = extractImpliedForward(calls, strikes.map((k) => quote(k, "put")), 100, 0.5, 0.04);
    expect(result.forward).toBeCloseTo(forwardFromCarry(100, 0.5, 0.04, 0.015)!, 6);
    expect(result.warnings).toContain("Parity forward quote intervals disagree");
  });
  test("stale far-strike pairs cannot set a forward far from spot carry", () => {
    // Quotes left on pre-split contracts implied a forward of 5.5x spot.
    const stale = (strike: number, call: number, put: number) => [
      { strike, bid: call - 8, ask: call + 8, contractSymbol: `call${strike}` },
      { strike, bid: put - 1, ask: put + 1, contractSymbol: `put${strike}` },
    ] as const;
    const pairs = [stale(470, 820, 24), stale(480, 814, 25)];
    const result = extractImpliedForward(pairs.map(([call]) => call), pairs.map(([, put]) => put), 229, 0.24, 0.04);
    expect(result.forward).toBeNull();
    expect(result.warnings).toEqual(["Parity forwards are inconsistent with spot"]);
    // VIX options settle on a future that can trade far from the spot index.
    const vix = extractImpliedForward(pairs.map(([call]) => call), pairs.map(([, put]) => put), 229, 0.24, 0.04, "^VIX");
    expect(vix.forward).not.toBeNull();
    // A stale pair nearest spot is skipped for the next valid strike.
    const strikes = [90, 95, 100, 110, 115];
    const [call105, put105] = stale(105, 400, 1);
    const mixed = extractImpliedForward([...strikes.map((k) => quote(k, "call")), call105],
      [...strikes.map((k) => quote(k, "put")), put105], 100, 0.5, 0.04);
    expect(mixed.pairs.map((pair) => pair.strike)).toEqual([95, 100, 110, 115]);
    expect(mixed.forward).toBeCloseTo(forwardFromCarry(100, 0.5, 0.04, 0.015)!, 6);
  });
  test("the existing IV solver recovers volatility when forward is the underlying", () => {
    const forward = forwardFromCarry(input.spot, input.years, input.rate, input.dividendYield)!;
    // Setting q=r gives discounted Black forward pricing without duplicating a pricer.
    const draft = { ...DEFAULT_OPTION_CALC_DRAFT, ...input, spot: forward, strike: 110,
      daysToExpiry: input.years * 365, dividendYield: input.rate };
    const mid = (quote(110, "call").bid + quote(110, "call").ask) / 2;
    expect(solveImpliedVolatility(draft, mid).volatility).toBeCloseTo(input.volatility, 6);
    expect(solveImpliedVolatility(draft, forward + 1).volatility).toBeNull();
  });
});

test("expected move uses a same-strike ATM straddle and separate one-sigma estimate", () => {
  const call = quote(100, "call"), put = quote(100, "put");
  const move = expectedMove([call], [put], 100, 0.5, 0.3);
  expect(move.straddle).toBeCloseTo(optionMid(call)! + optionMid(put)!, 9);
  expect(move.sigma).toBeCloseTo(100 * 0.3 * Math.sqrt(0.5), 8);
  expect(move.sigmaPercent).toBe(move.sigma);
  expect(expectedMove([quote(90, "call")], [quote(110, "put")], 100, 0.5, 0.3).straddle).toBeNull();
  expect(expectedMove([quote(110, "call")], [quote(110, "put")], 100, 0.5, 0.3).straddle).toBeNull();
  expect(expectedMove([], [], 100, 0, 0.3).sigma).toBe(0);
  expect(expectedMove([quote(105, "call")], [quote(105, "put")], 100, 0.5, 0.3).straddle).not.toBeNull();
  const huge = { strike: 100, bid: 1e308, ask: 1e308 };
  expect(expectedMove([huge], [huge], 100, 0.5, 0.3).straddle).toBeNull();
});

test("skew signs distinguish put premium from conventional call-minus-put risk reversal", () => {
  const flat = smileSkew(input, () => 0.3);
  expect(flat.put25).toBeCloseTo(0.3, 8);
  expect(flat.butterfly).toBe(0);
  expect(smileSkew({ spot: 100, years: 1, rate: 0 }, () => 2).call25).toBeCloseTo(2, 8);
  expect(Object.values(smileSkew({ ...input, spot: NaN }, () => 0.3)).every((value) => value === null)).toBe(true);
  const smile = (strike: number) => 0.3 - 0.03 * Math.log(strike / 100);
  const skew = smileSkew(input, smile);
  expect(skew.putCallSkew!).toBeGreaterThan(0);
  expect(skew.riskReversal).toBe(-skew.putCallSkew!);
  expect(skew.moneynessSkew).toBeCloseTo(smile(90) - smile(110), 9);
  expect(volatilityTermSlope({ years: 0.25, volatility: 0.4 }, { years: 0.5, volatility: 0.3 })).toBeCloseTo(-0.4, 9);
  expect(volatilityTermSlope({ years: 0.5, volatility: 0.4 }, { years: 0.5, volatility: 0.3 })).toBeNull();
});
