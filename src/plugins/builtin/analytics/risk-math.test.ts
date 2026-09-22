import { expect, test } from "bun:test";
import {
  concentration,
  historicalTail,
  pairedReturns,
  regressReturns,
  rollingBasketRisk,
  rollingBeta,
  subtractReturns,
} from "./risk-math";
import type { DatedReturn } from "./metrics";
function returns(length = 140): DatedReturn[] {
  const start = Date.parse("2025-01-01");
  return Array.from({ length }, (_, index) => ({
    startDateKey: new Date(start + index * 86_400_000)
      .toISOString()
      .slice(0, 10),
    dateKey: new Date(start + (index + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    value: Math.sin(index) / 100,
  }));
}
test("historical VaR uses the declared tail and expected shortfall retains tail losses", () => {
  const tail = historicalTail([...Array(57).fill(0.01), -0.03, -0.02, -0.01])!;
  expect(tail.var).toBe(0.01);
  expect(tail.expectedShortfall).toBeCloseTo(0.02, 12);
  expect(historicalTail(Array(59).fill(0))).toBeNull();
  expect(historicalTail(Array(60).fill(0.01))).toEqual({
    var: 0,
    expectedShortfall: 0,
  });
});
test("beta matches both interval endpoints and refuses a constant explanatory series", () => {
  const factor = returns(),
    asset = factor.map((row) => ({ ...row, value: 0.001 + 2 * row.value }));
  const result = regressReturns(asset, factor)!;
  expect(result.beta).toBeCloseTo(2, 12);
  expect(result.intercept).toBeCloseTo(0.001, 12);
  expect(result.rSquared).toBeCloseTo(1, 12);
  expect(
    regressReturns(
      asset,
      factor.map((row) => ({ ...row, value: 0 })),
    ),
  ).toBeNull();
  const wrong = factor.map((row) => ({ ...row, startDateKey: "2024-01-01" }));
  expect(pairedReturns(asset, wrong)).toEqual([]);
  expect(regressReturns(asset, wrong)).toBeNull();
  expect(subtractReturns(asset, factor)[0]!.value).toBeCloseTo(
    0.001 + factor[0]!.value,
    12,
  );
});
test("rolling risk preserves missing intervals and computes same-horizon historical percentiles", () => {
  const asset = returns(),
    sample = pairedReturns(asset, asset);
  const result = rollingBasketRisk(sample);
  expect(result.find((row) => row.id === "active")!.value).toBe(0);
  expect(result.find((row) => row.id === "active")!.rank.percentile).toBe(50);
  expect(result.find((row) => row.id === "tracking")!.value).toBe(0);
  expect(
    result.every(
      (row) =>
        row.samples === 60 && row.startDate === sample.at(-60)!.startDateKey,
    ),
  ).toBe(true);
  const missing = sample.filter((_, index) => index !== 100);
  expect(rollingBasketRisk(missing).every((row) => row.value === null)).toBe(
    true,
  );
  expect(rollingBeta(asset, asset, "Market", "market").value).toBeCloseTo(
    1,
    12,
  );
  expect(rollingBeta(asset, asset, "Market", "market").rank.percentile).toBe(
    50,
  );
});
test("concentration uses gross signed exposure and never renormalizes an unvalued holding", () => {
  const result = concentration([
    { id: "a", value: 60 },
    { id: "b", value: -40 },
  ])!;
  expect(result.gross).toBe(100);
  expect(result.net).toBe(20);
  expect(result.hhi).toBeCloseTo(0.52, 12);
  expect(result.top).toBe(0.6);
  expect(
    concentration([
      { id: "a", value: 60 },
      { id: "b", value: null },
    ]),
  ).toBeNull();
});
