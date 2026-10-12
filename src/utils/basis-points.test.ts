import { expect, test } from "bun:test";
import { formatBasisPoints, toBasisPoints } from "./basis-points";

test("reads percentage points as signed basis points without float noise or a negative zero", () => {
  expect([0.44, 0.07, -0.12, 0.125, 0.004, -0.004, 0].map((value) => formatBasisPoints(value)))
    .toEqual(["+44bp", "+7bp", "-12bp", "+13bp", "0bp", "0bp", "0bp"]);
  expect(Object.is(toBasisPoints(-0.004), -0)).toBe(false);
  // Cboe yield indices are quoted to a thousandth: 5.244 against 5.231 is 1.3bp.
  expect(formatBasisPoints(5.244 - 5.231, 1)).toBe("+1.3bp");
  expect(formatBasisPoints(-0.0004, 1)).toBe("0.0bp");
  expect(toBasisPoints(0.445, 1)).toBe(44.5);
});
