import { expect, test } from "bun:test";
import { formatRate } from "./pairs";

test("inverse yen rates retain meaningful precision instead of rounding a material FX move away", () => {
  expect(formatRate(1 / 149, "USD")).toBe("0.0067114");
  expect(formatRate(1 / 151, "USD")).toBe("0.0066225");
  expect(formatRate(149.25, "JPY")).toBe("149.25");
  expect(formatRate(1.08, "USD")).toBe("1.0800");
  expect(formatRate(Number.POSITIVE_INFINITY, "USD")).toBe("—");
  expect(formatRate(0, "USD")).toBe("—");
});
