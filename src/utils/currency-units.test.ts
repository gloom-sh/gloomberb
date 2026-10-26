import { describe, expect, test } from "bun:test";
import {
  currencyCodeLabel,
  currencyUnitLabel,
  fxRateCurrencies,
  hasLikelyQuoteUnitMismatch,
  minorUnitSign,
  resolveCurrencyUnit,
  resolveExchangeSubUnitCurrencyUnit,
  resolvePriceHistoryCurrencyUnit,
} from "./currency-units";

describe("currency unit helpers", () => {
  test("names a minor unit's sign and shows US cents as US¢, a major currency as its code", () => {
    expect([minorUnitSign("USX"), minorUnitSign("GBp"), minorUnitSign("GBX"), minorUnitSign("ZAc")]).toEqual(["¢", "p", "p", "c"]);
    // GBP is pounds, not pence; agorot have no sign in common use.
    expect([minorUnitSign("GBP"), minorUnitSign("USD"), minorUnitSign("ILA"), minorUnitSign(null)]).toEqual([null, null, null, null]);
    expect([currencyCodeLabel("USX"), currencyCodeLabel("GBp"), currencyCodeLabel("USD")]).toEqual(["US¢", "GBp", "USD"]);
    expect(currencyUnitLabel("USX", { ofMajor: true })).toBe("US¢ (US cents, 1/100 USD)");
  });

  test("normalizes known sub-unit currencies to their main currency", () => {
    expect(resolveCurrencyUnit("GBp")).toEqual({ currency: "GBP", divisor: 100 });
    expect(resolveCurrencyUnit("GBP")).toEqual({ currency: "GBP", divisor: 1 });
  });

  test("normalizes known sub-unit history exchanges reported as main currency", () => {
    expect(resolvePriceHistoryCurrencyUnit("GBP", "LSE")).toEqual({ currency: "GBP", divisor: 100 });
    expect(resolvePriceHistoryCurrencyUnit("USD", "LSE")).toEqual({ currency: "GBP", divisor: 100 });
    expect(resolvePriceHistoryCurrencyUnit("GBP", "NASDAQ")).toEqual({ currency: "GBP", divisor: 1 });
  });

  test("finds sub-unit exchange rules across multiple exchange candidates", () => {
    expect(resolveExchangeSubUnitCurrencyUnit("GBP", ["SMART", "LSE"])).toEqual({
      currency: "GBP",
      divisor: 100,
    });
    expect(resolveExchangeSubUnitCurrencyUnit("USD", ["SMART", "LSE"])).toEqual({
      currency: "USD",
      divisor: 1,
    });
  });

  test("detects sub-unit quotes that match the same main-currency price", () => {
    expect(hasLikelyQuoteUnitMismatch(
      { price: 23.1, currency: "GBp" },
      { price: 0.231, currency: "GBP" },
    )).toBe(true);
  });

  test("detects classic same-currency 100x mismatches", () => {
    expect(hasLikelyQuoteUnitMismatch(
      { price: 24.5, currency: "GBP" },
      { price: 0.245, currency: "GBP" },
    )).toBe(true);
  });

  test("detects likely 1000x mismatches for three-decimal currencies", () => {
    expect(hasLikelyQuoteUnitMismatch(
      { price: 721, currency: "KWD" },
      { price: 0.721, currency: "KWD" },
    )).toBe(true);
  });

  test("does not flag similar quotes that already use the same unit", () => {
    expect(hasLikelyQuoteUnitMismatch(
      { price: 0.231, currency: "GBP" },
      { price: 0.245, currency: "GBP" },
    )).toBe(false);
  });

  test("does not assume 1000x mismatches for ordinary two-decimal currencies", () => {
    expect(hasLikelyQuoteUnitMismatch(
      { price: 231, currency: "USD" },
      { price: 0.231, currency: "USD" },
    )).toBe(false);
  });
});

test("the rates converting a minor unit include its major currency's, which GBX and ILA have none without", () => {
  expect(fxRateCurrencies(["GBX", "ZAc", "ILA", "GBp", "usd", "USX", " ", null, undefined])).toEqual(["GBP", "GBX", "ILA", "ILS", "USD", "USX", "ZAC", "ZAR"]);
});
