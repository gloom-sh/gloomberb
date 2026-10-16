import { expect, test } from "bun:test";
import { parseFxArgs, parseFxRequest } from "./fx-pair";

test("a pair typed without its slash is answered with the slash form, and only when both halves are currencies", () => {
  expect(parseFxRequest("eurusd", "USD")).toEqual({ error: "EURUSD is not a currency code; write the pair as EUR/USD." });
  expect(parseFxRequest("EUR/USD", "USD")).toEqual({ currency: "EUR", baseCurrency: "USD" });
  // Six letters that are not two codes (SHE, LLS) get the plain error, not a made-up pair.
  expect(parseFxRequest("SHELLS", "USD")).toEqual({ error: "SHELLS is not a currency code; use three letters such as NGN." });
});

test("an amount in front converts from the first currency to the second, read with either decimal mark", () => {
  const eurUsd = { currency: "EUR", baseCurrency: "USD" };
  expect(parseFxArgs(["EUR"], "GBP")).toEqual({ request: { currency: "EUR", baseCurrency: "GBP" } });
  expect(parseFxArgs(["1234.5", "EUR/USD"], "GBP")).toEqual({ request: eurUsd, amount: 1234.5 });
  expect(parseFxArgs(["1234,5", "eur", "usd"], "GBP")).toEqual({ request: eurUsd, amount: 1234.5 });
  expect(parseFxArgs(["1.234,5", "EUR/USD"], "GBP")).toEqual({ request: eurUsd, amount: 1234.5 });
  // One currency after an amount converts to USD, not the base currency, and says so.
  expect(parseFxArgs(["1234.5", "EUR"], "GBP")).toEqual({ request: eurUsd, amount: 1234.5, toUsdByDefault: true });
  expect(parseFxArgs(["1,234", "EUR/USD"], "USD")).toEqual({
    error: "The amount 1,234 could be 1234 (thousands) or 1.234 (decimal comma); type 1234 or 1.2340.",
  });
  expect(parseFxArgs(["EUR/USD", "100"], "USD")).toEqual({ error: "Put the amount first: fx 100 EUR/USD." });
  // Two codes are never two answers; the error writes them as one pair, with the amount form beside it.
  expect(parseFxArgs(["NGN", "ZAR"], "USD")).toEqual({
    error: "fx takes one currency or pair; got NGN ZAR. Write a pair as NGN/ZAR, or convert an amount as fx 1234.5 NGN/ZAR.",
  });
  expect(parseFxArgs(["100"], "USD")).toEqual({ error: "fx 100 names no currency; convert an amount as fx 100 EUR/USD." });
  expect(parseFxArgs(["100", "EUR", "USD", "GBP"], "USD")).toMatchObject({ error: expect.stringContaining("fx 1234.5 EUR/USD") });
});
