import { expect, test } from "bun:test";
import { FX_CURRENCIES, MAJOR_CURRENCIES, formatRate, resolveCurrencies } from "./pairs";

test("a cross prints at its pair's precision: yen from 1 up to three decimals, below 1 five significant digits", () => {
  expect(formatRate(1 / 149, "USD")).toBe("0.0067114");
  expect(formatRate(149.25, "JPY")).toBe("149.250");
  expect(formatRate(1.08, "USD")).toBe("1.08000");
  // KRW/JPY and IDR/JPY are yen below 1: three decimals read them 0.107 and 0.010.
  expect(formatRate(0.10712, "JPY")).toBe("0.10712");
  expect(formatRate(0.009612, "JPY")).toBe("0.0096120");
  expect(formatRate(Number.POSITIVE_INFINITY, "USD")).toBe("—");
  expect(formatRate(0, "USD")).toBe("—");
});

test("a cross ticking across a power of ten keeps the decimals of its reference rate", () => {
  expect(formatRate(0.00999, "AUD", 0.01001)).toBe("0.009990");
  expect(formatRate(0.01001, "AUD", 0.00999)).toBe("0.0100100");
  expect(formatRate(49.99996, "TRY", 50.01)).toBe("50.000");
});

test("crosses from 3e-5 to 85,000 stay inside a ten-character column", () => {
  // VND/GBP, KRW/JPY, USD/TRY, USD/KRW, GBP/VND.
  expect([[1 / (25_900 * 1.27), "GBP"], [0.1119, "JPY"], [32.4567, "TRY"], [1340.5, "KRW"], [33_000.123, "VND"]].map(([rate, currency]) => formatRate(rate as number, currency as string)))
    .toEqual(["0.00003040", "0.11190", "32.45670", "1340.50", "33000.12"]);
  for (const rate of [3.0e-5, 5.6e-5, 0.00057, 0.0067, 0.1, 49.9999, 99.999, 515.5, 17_900.5, 85_000]) {
    for (const currency of ["JPY", "USD"]) expect(formatRate(rate, currency).length).toBeLessThanOrEqual(10);
  }
});

test("the saved selection keeps its order and drops what the board does not carry", () => {
  expect(resolveCurrencies(["KRW", "USD", "EUR", "XXX", "KRW"])).toEqual(["KRW", "USD", "EUR"]);
  expect(resolveCurrencies(undefined)).toEqual([...MAJOR_CURRENCIES]);
  expect(resolveCurrencies([])).toEqual([...MAJOR_CURRENCIES]);
  expect(resolveCurrencies(["XXX", "RUB"])).toEqual([...MAJOR_CURRENCIES]);
  expect(resolveCurrencies(["usd"])).toEqual([...MAJOR_CURRENCIES]);
  // Written by hand into a layout file, or typed as --currencies: still a list of codes.
  expect(resolveCurrencies("eur, KRW,xxx")).toEqual(["EUR", "KRW"]);
  expect(resolveCurrencies("G10")).toEqual([...MAJOR_CURRENCIES, "SEK", "NOK"]);
  expect(resolveCurrencies("all")).toEqual([...FX_CURRENCIES]);
  expect(resolveCurrencies(42)).toEqual([...MAJOR_CURRENCIES]);
});
