import { expect, test } from "bun:test";
import { growthRate, NOT_MEANINGFUL, outflowGrowthRate, rateValue, revenueMargin } from "./growth";
import { epsSurprise } from "../plugins/builtin/shared/earnings-report";
import { signedPercent } from "../plugins/builtin/earnings/format";

test("growth off a zero or negative base is N/M, never a percentage of a loss", () => {
  expect(growthRate(12, 10)).toBeCloseTo(0.2, 12);
  expect(growthRate(-5, 10)).toBeCloseTo(-1.5, 12);
  expect(growthRate(0, 10)).toBe(-1);
  // A loss of 10 narrowing to 5, or turning into a profit of 5: no percentage of the loss.
  expect(growthRate(-5, -10)).toBe(NOT_MEANINGFUL);
  expect(growthRate(5, -10)).toBe(NOT_MEANINGFUL);
  expect(growthRate(5, 0)).toBe(NOT_MEANINGFUL);
  expect(growthRate(undefined, 10)).toBeUndefined();
  expect(growthRate(5, null)).toBeUndefined();
  expect(growthRate(Number.NaN, 10)).toBeUndefined();
  expect(rateValue(growthRate(5, -10))).toBeNull();
});

test("an outflow grows as the money that went out", () => {
  expect(outflowGrowthRate(-12, -10)).toBeCloseTo(0.2, 12);
  expect(outflowGrowthRate(-8, -10)).toBeCloseTo(-0.2, 12);
  expect(outflowGrowthRate(0, -10)).toBe(-1);
  expect(outflowGrowthRate(-12, 0)).toBe(NOT_MEANINGFUL);
  expect(outflowGrowthRate(3, -10)).toBe(NOT_MEANINGFUL);
});

test("a margin over zero or negative revenue is N/M", () => {
  expect(revenueMargin(20, 100)).toBe(0.2);
  expect(revenueMargin(-20, 100)).toBe(-0.2);
  expect(revenueMargin(-20, -100)).toBe(NOT_MEANINGFUL);
  expect(revenueMargin(20, 0)).toBe(NOT_MEANINGFUL);
  expect(revenueMargin(undefined, -100)).toBeUndefined();
  expect(revenueMargin(20, undefined)).toBeUndefined();
});

test("an earnings surprise against a loss or zero estimate reads N/M", () => {
  expect(epsSurprise(0.55, 0.5)).toBeCloseTo(0.1, 12);
  expect(epsSurprise(-1.14, -1.47)).toBe(NOT_MEANINGFUL);
  expect(epsSurprise(0.02, 0)).toBe(NOT_MEANINGFUL);
  expect(epsSurprise(null, 0.5)).toBeNull();
  expect(signedPercent(epsSurprise(-1.14, -1.47))).toBe("N/M");
  expect(signedPercent(epsSurprise(0.55, 0.5))).toBe("+10.0%");
  expect(signedPercent(null)).toBe("--");
});
