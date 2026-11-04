import { expect, test } from "bun:test";
import { formatRatioAxisValue, formatRatioValue } from "./view-model";

test("a small ratio's axis ticks keep enough decimals to differ, and ordinary ratios keep theirs", () => {
  const domain = { min: 0.00045, max: 0.0007 };
  expect([0.0005, 0.0006, 0.0007].map((tick) => formatRatioAxisValue(tick, domain))).toEqual(["0.00050x", "0.00060x", "0.00070x"]);
  expect(formatRatioAxisValue(1.234, { min: 1, max: 1.5 })).toBe("1.234x");
  expect(formatRatioAxisValue(25.43, { min: 20, max: 30 })).toBe("25.4x");
  expect(formatRatioValue(0.4271)).toBe("0.4271x");
});
