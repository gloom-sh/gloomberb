import { expect, test } from "bun:test";
import { isKnownUsStock } from "./known-us-stocks";

test("a symbol is a known US stock when the shipped listings list it as one, in any case", () => {
  for (const symbol of ["NVDA", "META", "TSLA", "AAPL", "V", "mco", " jpm "]) expect(isKnownUsStock(symbol), symbol).toBe(true);
});

test("a fund, a symbol nothing lists and a coin are not, so their lookups still ask for perpetual contracts", () => {
  // SPY and QQQ are funds, BTC and ETH are listed as funds too, and QWZXQ is listed nowhere.
  for (const symbol of ["SPY", "QQQ", "QWZXQ", "ETH", "BTC", ""]) expect(isKnownUsStock(symbol), symbol).toBe(false);
});

test("a US line the shipped listings mark as stopped is not one, so its symbol is read past it", () => {
  // CS is Credit Suisse's NYSE receipt, delisted in 2023, beside AXA's home line in Paris: `quote CS` is AXA, as the command bar reads it.
  expect(isKnownUsStock("CS")).toBe(false);
});
