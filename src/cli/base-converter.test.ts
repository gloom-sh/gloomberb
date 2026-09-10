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
