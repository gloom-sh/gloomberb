import { expect, test } from "bun:test";
import { dottedDecimal, numberErrorMessage } from "./decimal-comma";

test("a digits-comma-digits value reads as the dotted number, and nothing else does", () => {
  expect(dottedDecimal("4,5")).toBe("4.5");
  expect(dottedDecimal(" -0,25 ")).toBe("-0.25");
  expect(dottedDecimal("+12,75")).toBe("+12.75");
  expect(dottedDecimal("4,125000")).toBe("4.125000");
  // A thousands comma, a list, a trailing comma and text are not decimals; neither is a number that is not a string.
  for (const value of ["1,234", "95,000", "4,5,6", "1,234,567", "4,", ",5", "4.5", "4,5%", "", null, 4.5]) {
    expect(dottedDecimal(value)).toBeNull();
  }
});

test("the message gains the dotted number, and a closing period gives way to it", () => {
  expect(numberErrorMessage("Coupon must be a number", "4,5")).toBe("Coupon must be a number; use a dot: 4.5");
  expect(numberErrorMessage("Alert price must be a finite number.", "250,5")).toBe("Alert price must be a finite number; use a dot: 250.5");
  expect(numberErrorMessage("Coupon must be a number", "abc")).toBe("Coupon must be a number");
  expect(numberErrorMessage("Alert price must be a finite number.", "95,000")).toBe("Alert price must be a finite number.");
});
