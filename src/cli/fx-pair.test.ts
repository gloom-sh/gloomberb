import { expect, test } from "bun:test";
import { parseFxRequest } from "./fx-pair";

test("a pair typed without its slash is answered with the slash form, and only when both halves are currencies", () => {
  expect(parseFxRequest("eurusd", "USD")).toEqual({ error: "EURUSD is not a currency code; write the pair as EUR/USD." });
  expect(parseFxRequest("EUR/USD", "USD")).toEqual({ currency: "EUR", baseCurrency: "USD" });
  // Six letters that are not two codes (SHE, LLS) get the plain error, not a made-up pair.
  expect(parseFxRequest("SHELLS", "USD")).toEqual({ error: "SHELLS is not a currency code; use three letters such as NGN." });
});
