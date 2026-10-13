import { expect, test } from "bun:test";
import { currencyPairSpelling, looksLikeCurrencyPair } from "./currency-pair";

test("every spelling of a pair is the one listing the service has for it", () => {
  const read = (typed: string, exchange?: string) => currencyPairSpelling(typed, exchange);
  for (const typed of ["USDNGN=X", "USD/NGN", "usd/ngn", "USDNGN:CCY", "usdngn:fx", "NGN=X", "ngn=x"]) {
    expect(read(typed), typed).toEqual({ symbol: "USDNGN=X", ambiguous: false });
  }
  // The dollar pair's short spelling is the dollar first.
  expect(read("JPY=X")).toEqual({ symbol: "USDJPY=X", ambiguous: false });
  expect(read("EUR/USD")).toEqual({ symbol: "EURUSD=X", ambiguous: false });
  // Named on the currency venue, six letters or a dash are a pair outright.
  expect(read("EURUSD", "CCY")).toEqual({ symbol: "EURUSD=X", ambiguous: false });
  expect(read("EUR-USD", "FX")).toEqual({ symbol: "EURUSD=X", ambiguous: false });
  // A dash or six bare letters could be a security's symbol: search decides.
  for (const typed of ["USD-NGN", "usd-ngn", "USDNGN", "usdngn"]) {
    expect(read(typed), typed).toEqual({ symbol: "USDNGN=X", ambiguous: true });
  }
  expect(read("MNT-USD")).toEqual({ symbol: "MNTUSD=X", ambiguous: true });
});

test("symbols that are not two currency codes are left alone", () => {
  for (const typed of [
    "BTC-USD", "BTC/USD", "ETH-EUR", "BRK-B", "BIP-UN", "AAPL", "GOOGLE", "NVDAUS", "ES=F", "^GSPC", "7203",
    // Metals and drawing rights have ISO codes but no FX pair here.
    "XAU/USD", "XAUUSD=X", "USD/XDR",
    // A code against itself, an unknown code, and the dollar on its own.
    "USD/USD", "USD/XYZ", "XYZ=X", "USD=X",
  ]) {
    expect(currencyPairSpelling(typed), typed).toBeNull();
  }
  // A listing on a venue other than the currency venue is that listing.
  expect(currencyPairSpelling("EURUSD", "NYSE")).toBeNull();
  expect(currencyPairSpelling("EUR/USD:LSE")).toBeNull();
});

test("a miss written like a pair, with one half a currency code, is worth a pair search", () => {
  for (const symbol of ["USD/XYZ", "USD-NGM", "USD_NGN", "USDNGM", "XYZUSD=X", "NGN=X"]) expect(looksLikeCurrencyPair(symbol), symbol).toBe(true);
  for (const symbol of ["APPLE", "BRK-B", "ABC/DEF", "ZZZZQQ", "BTC-USDT"]) expect(looksLikeCurrencyPair(symbol), symbol).toBe(false);
});
