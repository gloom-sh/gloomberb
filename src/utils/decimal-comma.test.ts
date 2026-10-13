import { expect, test } from "bun:test";
import { ambiguousNumberMessage, dottedDecimal, numberErrorMessage, parsePastedNumber } from "./decimal-comma";

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

test("a number pasted from a sheet reads with its last mark as the decimal one and the marks before it as grouping", () => {
  const nbsp = "\u00a0";
  const narrow = "\u202f";
  const read: Array<[string, number]> = [
    ["1350.5", 1350.5],
    ["1.350", 1.35],
    ["1,350.5", 1350.5],
    ["1.350,5", 1350.5],
    ["1 350,5", 1350.5],
    [`1${nbsp}350,5`, 1350.5],
    [`1${narrow}350,5`, 1350.5],
    ["1 350.5", 1350.5],
    ["1,350,000", 1350000],
    ["1.350.000", 1350000],
    ["1 350 000", 1350000],
    ["12.345.678,9", 12345678.9],
    ["1350,5", 1350.5],
    ["0,350", 0.35],
    ["1234,567", 1234.567],
    ["-1.350,5", -1350.5],
    ["+1,350.5", 1350.5],
    [" 250,5 ", 250.5],
    ["250", 250],
  ];
  expect(read.map(([text]) => parsePastedNumber(text))).toEqual(read.map(([, value]) => ({ kind: "number", value })));
});

test("a comma and three digits could be thousands or a decimal comma, so both readings are named and nothing is guessed", () => {
  expect(parsePastedNumber("1,350")).toEqual({ kind: "ambiguous", thousands: 1350, decimal: 1.35 });
  expect(parsePastedNumber("12,345")).toEqual({ kind: "ambiguous", thousands: 12345, decimal: 12.345 });
  expect(parsePastedNumber("-950,000")).toEqual({ kind: "ambiguous", thousands: -950000, decimal: -950 });
  expect(ambiguousNumberMessage("1,350", { thousands: 1350, decimal: 1.35 }))
    .toBe("1,350 could be 1350 (thousands) or 1.35 (decimal comma); type 1350 or 1.35");
});

test("text that is not a number, or whose marks do not group in threes, is invalid", () => {
  for (const text of [
    "", "   ", "abc", "1,35.0", "1,23,456", "1.35.0", "1,350.5.5", "1.350,5,5", "1,234,5", "1.234.5", "1,,350", "1 3500", "1,350 000",
    "1,350%", "$1,350", ",5", "5,", "1,", "12e,5", "Infinity", "--5", "1 350,5 EUR",
  ]) {
    expect(parsePastedNumber(text)).toEqual({ kind: "invalid" });
  }
  expect(parsePastedNumber(null)).toEqual({ kind: "invalid" });
  expect(parsePastedNumber(250)).toEqual({ kind: "invalid" });
});
