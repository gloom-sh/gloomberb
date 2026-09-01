import { describe, expect, test } from "bun:test";
import { getIbkrPriceDivisor } from "./price-normalization";

describe("IBKR sub-unit price normalization", () => {
  test("detects pence-priced LSE equities", () => {
    expect(getIbkrPriceDivisor({
      currency: "GBP",
      exchange: "SMART",
      primaryExch: "LSE",
      secType: "STK",
    })).toBe(100);

    expect(getIbkrPriceDivisor({
      currency: "USD",
      exchange: "NASDAQ",
      primaryExch: "NASDAQ",
      secType: "STK",
    })).toBe(1);
  });

  test("detects sub-unit equities from valid exchanges", () => {
    expect(getIbkrPriceDivisor({
      currency: "GBP",
      exchange: "SMART",
      primaryExch: "SMART",
      secType: "ETF",
    }, {
      validExchanges: "SMART,LSE",
    })).toBe(100);
  });

  test("prefers contract price magnifier when available", () => {
    expect(getIbkrPriceDivisor({
      currency: "GBP",
      exchange: "SMART",
      primaryExch: "LSE",
      secType: "STK",
    }, {
      priceMagnifier: 1000,
      validExchanges: "SMART,LSE",
    })).toBe(1000);
  });

});
