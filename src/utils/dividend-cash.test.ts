import { expect, test } from "bun:test";
import { atSourcePrecision } from "./dividend-cash";

test("an amount reads at its source's precision: single-precision noise goes, stated digits stay", () => {
  expect([902.00006, 15.360001, 6.4058995, 1804.00012, 509.99999999999994, 17.799999999999997].map(atSourcePrecision))
    .toEqual([902, 15.36, 6.4059, 1804, 510, 17.8]);
  // Stated to eight digits, more than the noise: kept.
  expect(atSourcePrecision(2.0301435)).toBe(2.0301435);
});
