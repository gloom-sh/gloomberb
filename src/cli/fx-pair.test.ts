import { expect, test } from "bun:test";
import { parseFxArgs, parseFxRequest } from "./fx-pair";

test("a pair is read in every spelling quote takes, and only when both halves are currencies", () => {
  const eurUsd = { currency: "EUR", baseCurrency: "USD" };
  for (const typed of ["eurusd", "EUR/USD", "eur-usd", "EURUSD=X", "eurusd:ccy"]) expect(parseFxRequest(typed, "GBP"), typed).toEqual(eurUsd);
  expect(parseFxRequest("JPY=X", "GBP")).toEqual({ currency: "USD", baseCurrency: "JPY" });
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
  // A lone dot and three digits asks too: a dot-decimal reader's 1.234 is never converted as 1234.
  expect(parseFxArgs(["1.234", "EUR/USD"], "USD")).toEqual({
    error: "The amount 1.234 could be 1234 (thousands) or 1.234 (decimal point); type 1234 or 1.2340.",
  });
  expect(parseFxArgs(["1.5", "EUR/USD"], "USD")).toEqual({ request: eurUsd, amount: 1.5 });
  expect(parseFxArgs(["1,234", "KWD", "USD"], "USD")).toEqual({
    error: "The amount 1,234 could be 1234 (thousands) or 1.234 (decimal comma), and KWD has 3 decimals; type 1234 or 1.2340.",
  });
  // A comma and three digits asks in euros too, as `alerts add` asks about the same string; the dotted reading is typed so it does not read two ways.
  expect(parseFxArgs(["81,000", "EUR/USD"], "USD")).toEqual({
    error: "The amount 81,000 could be 81000 (thousands) or 81 (decimal comma); type 81000 or 81.",
  });
  expect(parseFxArgs(["1,234", "EUR", "USD"], "USD")).toEqual({
    error: "The amount 1,234 could be 1234 (thousands) or 1.234 (decimal comma); type 1234 or 1.2340.",
  });
  expect(parseFxArgs(["81000", "EUR/USD"], "USD")).toEqual({ request: eurUsd, amount: 81000 });
  // An amount as reports print it: thousands, millions, billions.
  const usdEur = { currency: "USD", baseCurrency: "EUR" };
  expect(parseFxArgs(["959.81M", "USD/EUR"], "USD")).toEqual({ request: usdEur, amount: 959_810_000 });
  expect(parseFxArgs(["25k", "USD", "EUR"], "USD")).toEqual({ request: usdEur, amount: 25_000 });
  expect(parseFxArgs(["1,2B", "USD/EUR"], "USD")).toEqual({ request: usdEur, amount: 1_200_000_000 });
  expect(parseFxArgs(["EUR/USD", "100"], "USD")).toEqual({ error: "Put the amount first: fx 100 EUR/USD." });
  // Two codes are never two answers; the error writes them as one pair, with the amount form beside it.
  expect(parseFxArgs(["NGN", "ZAR"], "USD")).toEqual({
    error: "fx takes one currency or pair; got NGN ZAR. Write a pair as NGN/ZAR, or convert an amount as fx 1234.5 NGN/ZAR.",
  });
  expect(parseFxArgs(["100"], "USD")).toEqual({ error: "fx 100 names no currency; convert an amount as fx 100 EUR/USD." });
  expect(parseFxArgs(["100", "EUR", "USD", "GBP"], "USD")).toMatchObject({ error: expect.stringContaining("fx 1234.5 EUR/USD") });
});

test("a currency's name reads as its code, and a name several currencies share lists them", () => {
  // One currency's name, in any case, plural or with its country, is its code, and the answer says which it read.
  expect(parseFxRequest("yen", "USD")).toEqual({ currency: "JPY", baseCurrency: "USD", readAs: ["Read yen as JPY."] });
  expect(parseFxRequest("Rand", "USD")).toMatchObject({ currency: "ZAR" });
  expect(parseFxRequest("real", "USD")).toMatchObject({ currency: "BRL" });
  expect(parseFxRequest("lira", "USD")).toMatchObject({ currency: "TRY" });
  expect(parseFxRequest("won", "USD")).toMatchObject({ currency: "KRW" });
  expect(parseFxRequest("krona", "USD")).toMatchObject({ error: expect.stringContaining("SEK (Swedish), ISK (Icelandic)") });
  expect(parseFxRequest("krone", "USD")).toMatchObject({ error: expect.stringContaining("NOK (Norwegian), DKK (Danish)") });
  expect(parseFxRequest("Swiss Franc", "USD")).toMatchObject({ currency: "CHF" });
  expect(parseFxRequest("franc", "USD")).toMatchObject({ error: expect.stringContaining("CHF (Swiss)") });
  expect(parseFxRequest("rupees", "USD")).toMatchObject({ error: expect.stringContaining("INR (Indian)") });
  expect(parseFxRequest("EUR/yen", "USD")).toMatchObject({ currency: "EUR", baseCurrency: "JPY" });

  // Peso is not one currency: it lists the candidates instead of "PESO is not a currency code", and says how to write one.
  const peso = parseFxRequest("peso", "USD");
  expect(peso).toEqual({
    error: "peso names several currencies: MXN (Mexican), ARS (Argentine), COP (Colombian), CLP (Chilean), PHP (Philippine), UYU (Uruguayan), DOP (Dominican). Write one as its code, such as fx MXN.",
  });
  expect(parseFxRequest("USD/peso", "USD")).toMatchObject({ error: expect.stringContaining("such as fx USD/MXN") });
  expect(parseFxRequest("dollar", "USD")).toMatchObject({ error: expect.stringContaining("USD (US), CAD (Canadian), AUD (Australian)") });

  // A code stays a code: a name never takes the place of three letters that are one, and anything else is still no currency.
  expect(parseFxRequest("NGN", "USD")).toEqual({ currency: "NGN", baseCurrency: "USD" });
  expect(parseFxRequest("SHELLS", "USD")).toEqual({ error: "SHELLS is not a currency code; use three letters such as NGN." });

  // A name of several words is one argument, with or without an amount in front.
  expect(parseFxArgs(["hong", "kong", "dollar"], "USD")).toMatchObject({ request: { currency: "HKD" } });
  expect(parseFxArgs(["100", "swiss", "franc"], "GBP")).toMatchObject({ request: { currency: "CHF", baseCurrency: "USD" }, amount: 100, toUsdByDefault: true });
});

test("a minor unit reads as a fraction of its major currency, pence only in their own case", () => {
  expect(parseFxRequest("ZAc/USD", "USD")).toEqual({ currency: "ZAR", baseCurrency: "USD", units: { currency: { code: "ZAc", divisor: 100 } } });
  expect(parseFxRequest("ila", "USD")).toEqual({ currency: "ILS", baseCurrency: "USD", units: { currency: { code: "ILA", divisor: 100 } } });
  expect(parseFxRequest("USD/GBp", "USD")).toEqual({ currency: "USD", baseCurrency: "GBP", units: { baseCurrency: { code: "GBp", divisor: 100 } } });
  expect(parseFxRequest("gbp/USD", "USD")).toEqual({ currency: "GBP", baseCurrency: "USD" });
  expect(parseFxArgs(["100", "ZAc", "USD"], "GBP")).toMatchObject({ request: { currency: "ZAR", units: { currency: { code: "ZAc" } } }, amount: 100 });
  // `fx GBp-USD` and `fx GBpUSD` quoted pounds: a pair spelled without its slash keeps its unit as typed.
  const pence = { currency: "GBP", baseCurrency: "USD", units: { currency: { code: "GBp", divisor: 100 } } };
  expect(parseFxRequest("GBp-USD", "EUR")).toEqual(pence);
  expect(parseFxRequest("GBpUSD", "EUR")).toEqual(pence);
  expect(parseFxRequest("zacusd", "EUR")).toEqual({ currency: "ZAR", baseCurrency: "USD", units: { currency: { code: "ZAc", divisor: 100 } } });
  expect(parseFxRequest("USD-ILA", "EUR")).toEqual({ currency: "USD", baseCurrency: "ILS", units: { baseCurrency: { code: "ILA", divisor: 100 } } });
  expect(parseFxArgs(["100", "GBpUSD"], "EUR")).toEqual({ request: pence, amount: 100 });
  expect(parseFxRequest("GBPUSD", "EUR")).toEqual({ currency: "GBP", baseCurrency: "USD" });
  expect(parseFxRequest("gbp-usd", "EUR")).toEqual({ currency: "GBP", baseCurrency: "USD" });
});

test("words pasted as one argument read as typed apart", () => {
  const eurUsd = { currency: "EUR", baseCurrency: "USD" };
  expect(parseFxArgs(["1234.5 eur/usd "], "GBP")).toEqual({ request: eurUsd, amount: 1234.5 });
  expect(parseFxArgs(["1234.5 EUR / USD"], "GBP")).toEqual({ request: eurUsd, amount: 1234.5 });
  expect(parseFxArgs(["959.81 M", "USD/EUR"], "GBP")).toEqual({ request: { currency: "USD", baseCurrency: "EUR" }, amount: 959_810_000 });
});

