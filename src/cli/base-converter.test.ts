import { expect, test } from "bun:test";
import { createBaseConverter } from "./base-converter";

test("CLI conversion preserves missing and invalid FX instead of valuing at parity", async () => {
  const convert = createBaseConverter({ getExchangeRate: async (currency) => {
    if (currency === "EUR") return 1.25;
    if (currency === "JPY") throw new Error("FX unavailable");
    return 0;
  } }, "EUR");
  expect(await convert(100, "USD")).toBe(80);
  expect(await convert(100, "EUR")).toBe(100);
  expect(await convert(100, "JPY")).toBeNaN();
  expect(await convert(100, "GBP")).toBeNaN();
  const missingBase = createBaseConverter({ getExchangeRate: async () => Number.NaN }, "GBP");
  expect(await missingBase(100, "USD")).toBeNaN();
});

test("CLI conversion counts a minor unit as a hundredth of its major currency, and asks only for major rates", async () => {
  const asked = new Set<string>();
  const rates: Record<string, number> = { EUR: 1.1, GBP: 1.25, ZAR: 0.055 };
  const provider = { getExchangeRate: async (currency: string) => {
    asked.add(currency);
    if (rates[currency] == null) throw new Error("FX unavailable");
    return rates[currency]!;
  } };
  expect(await createBaseConverter(provider, "USD")(7_000, "GBp")).toBeCloseTo(87.5, 9);
  const toEuros = createBaseConverter(provider, "EUR");
  expect(await toEuros(7_000, "GBX")).toBeCloseTo(70 * 1.25 / 1.1, 9);
  // The rate a report states is the pound's, which pence convert at a hundredth of.
  expect(toEuros.conversions()).toEqual([{ currency: "GBP", baseCurrency: "EUR", rate: 1.25 / 1.1, asOf: null, stale: false }]);
  expect(await createBaseConverter(provider, "USD")(10_000, "ZAc")).toBeCloseTo(5.5, 9);
  // Into a base in pence, and between pence written either way, which need no rate.
  expect(await createBaseConverter(provider, "GBp")(87.5, "USD")).toBeCloseTo(7_000, 9);
  expect(await createBaseConverter(provider, "GBX")(7_000, "GBp")).toBe(7_000);
  expect(await createBaseConverter(provider, "GBP")(7_000, "GBX")).toBe(70);
  expect([...asked].sort()).toEqual(["EUR", "GBP", "ZAR"]);
});
