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

  // A ticker opened from its quote keeps no type: the Overview of BTC-USD on CCC asked ticker/BTC-USD:CCC.
  test("asks for a coin's logo on the crypto path when its listing says it is a coin", () => {
    expect(resolveCompanyLogoSrc({ symbol: "BTC-USD", exchange: "CCC" })).toMatch(/\/cloud\/logos\/crypto\/BTC$/);
    expect(resolveCompanyLogoSrc({ symbol: "ETH-USD" })).toMatch(/\/cloud\/logos\/crypto\/ETH$/);
    expect(resolveCompanyLogoSrc({ symbol: "ETH-BTC" })).toMatch(/\/cloud\/logos\/crypto\/ETH$/);
    expect(resolveCompanyLogoSrc({ symbol: "BTC-USD:CCC", assetCategory: "CRYPTOCURRENCY" })).toMatch(/\/cloud\/logos\/crypto\/BTC$/);
    // A bare BTC is Grayscale's fund, a share class and a listing abroad are listings, whatever their dash.
    expect(resolveCompanyLogoSrc({ symbol: "BTC" })).toMatch(/\/cloud\/logos\/ticker\/BTC$/);
    expect(resolveCompanyLogoSrc({ symbol: "BRK-B" })).toMatch(/\/cloud\/logos\/ticker\/BRK-B$/);
    expect(resolveCompanyLogoSrc({ symbol: "0700", exchange: "HKEX" })).toMatch(/\/cloud\/logos\/ticker\/0700%3AHKEX$/);
    // A type that says it is no coin wins over the listing.
    expect(resolveCompanyLogoSrc({ symbol: "BTC-USD", assetCategory: "ETF" })).toMatch(/\/cloud\/logos\/ticker\/BTC-USD$/);
  });

  test("skips cash and options", () => {
    expect(resolveCompanyLogoSrc({ symbol: "USD", assetCategory: "CASH" })).toBeNull();
    expect(resolveCompanyLogoSrc({ symbol: "AAPL  240119C00190000", assetCategory: "OPT" })).toBeNull();
  });
});
