import { expect, test } from "bun:test";
import type { CompositeAxisDomain } from "../chart/composite/types";
import { formatCompactAxis } from "./axis";

test("compact ticks share one unit and take their decimals from the plotted range", () => {
  const domain = (min: number, max: number) => ({ min, max }) as CompositeAxisDomain;
  expect(formatCompactAxis(0, domain(0, 125e9))).toBe("0");
  expect(formatCompactAxis(50e9, domain(0, 125e9))).toBe("50B");
  expect(formatCompactAxis(91.2e9, domain(91e9, 92e9))).toBe("91.2B");
  expect(formatCompactAxis(91.25e9, domain(91e9, 91.5e9))).toBe("91.25B");
  expect(formatCompactAxis(750e6, domain(0, 900e6))).toBe("750M");
  // A mirrored axis (puts below zero) picks its unit from the larger side.
  expect(formatCompactAxis(-400e3, domain(-1.9e6, 600e3))).toBe("-0.4M");
});
