import { expect, test } from "bun:test";
import { FX_CURRENCIES, MAJOR_CURRENCIES, formatRate, resolveCurrencies } from "./pairs";

test("inverse yen rates retain meaningful precision instead of rounding a material FX move away", () => {
  expect(formatRate(1 / 149)).toBe("0.0067114");
  expect(formatRate(1 / 151)).toBe("0.0066225");
  expect(formatRate(149.25)).toBe("149.25");
  expect(formatRate(1.08)).toBe("1.0800");
  expect(formatRate(Number.POSITIVE_INFINITY)).toBe("—");
  expect(formatRate(0)).toBe("—");
});

test("a cross ticking across a power of ten keeps the decimals of its reference rate", () => {
  expect(formatRate(0.00999, 0.01001)).toBe("0.009990");
  expect(formatRate(0.01001, 0.00999)).toBe("0.0100100");
  expect(formatRate(49.99996, 50.01)).toBe("50.00");
  expect(formatRate(50.01, 49.99)).toBe("50.0100");
});

test("crosses from 3e-5 to 35,000 stay inside a ten-character column", () => {
  // VND/GBP, KRW/JPY, USD/TRY, USD/KRW, GBP/VND.
  expect([1 / (25_900 * 1.27), 0.1119, 32.4567, 1340.5, 33_000.123].map((rate) => formatRate(rate)))
    .toEqual(["0.00003040", "0.1119", "32.4567", "1340.50", "33000.12"]);
  for (const rate of [3.0e-5, 5.6e-5, 0.00057, 0.0067, 0.1, 49.9999, 99.999, 17_900.5, 35_000]) {
    expect(formatRate(rate).length).toBeLessThanOrEqual(10);
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
