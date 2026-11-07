import { describe, expect, test } from "bun:test";
import { resolveCompanyLogoSrc } from "./company-logo";

describe("resolveCompanyLogoSrc", () => {
  test("builds a ticker logo URL", () => {
    expect(resolveCompanyLogoSrc({ symbol: "aapl", assetCategory: "STK" }))
      .toMatch(/\/cloud\/logos\/ticker\/AAPL$/);
  });

  test("names a listing abroad by its venue, so BAE Systems (BA on LSE) never draws Boeing's logo", () => {
    expect(resolveCompanyLogoSrc({ symbol: "BA", assetCategory: "STK", exchange: "LSE" })).toMatch(/\/cloud\/logos\/ticker\/BA%3ALSE$/);
    expect(resolveCompanyLogoSrc({ symbol: "BA", assetCategory: "STK", exchange: "NYSE" })).toMatch(/\/cloud\/logos\/ticker\/BA$/);
  });

  test("maps crypto quote pairs onto the crypto path", () => {
    expect(resolveCompanyLogoSrc({ symbol: "btc-usd", assetCategory: "CRYPTO" }))
      .toMatch(/\/cloud\/logos\/crypto\/BTC$/);
  });

  test("skips cash and options", () => {
    expect(resolveCompanyLogoSrc({ symbol: "USD", assetCategory: "CASH" })).toBeNull();
    expect(resolveCompanyLogoSrc({ symbol: "AAPL  240119C00190000", assetCategory: "OPT" })).toBeNull();
  });
});
