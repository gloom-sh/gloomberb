import { describe, expect, test } from "bun:test";
import {
  quoteFormatOptions,
  formatMarketChangeWithCurrency,
  formatMarketCost,
  formatMarketCostWithCurrency,
  formatCompactMarketPriceWithCurrency,
  formatMarketPrice,
  formatPriceObservation,
  formatMarketPriceWithCurrency,
  formatMarketQuantity,
  formatSignedMarketPrice,
  resolveAssetDisplayKind,
} from "./format";

describe("resolveAssetDisplayKind", () => {
  test("prefers explicit cash balances", () => {
    expect(resolveAssetDisplayKind({ isCashBalance: true, assetCategory: "STK" })).toBe("cash");
  });

  test("maps common broker security types", () => {
    for (const assetCategory of ["CRYPTO", "CRYPTOCURRENCY", "Digital Currency"]) {
      expect(resolveAssetDisplayKind({ assetCategory })).toBe("crypto");
    }
    expect(resolveAssetDisplayKind({ assetCategory: "STK" })).toBe("equity");
    expect(resolveAssetDisplayKind({ contractSecType: "OPT" })).toBe("contract");
    expect(resolveAssetDisplayKind({ assetCategory: "FOREX" })).toBe("cash");
    expect(resolveAssetDisplayKind({ assetCategory: "CURRENCY" })).toBe("cash");
    expect(resolveAssetDisplayKind({ assetCategory: "CCY" })).toBe("cash");
  });

  test("falls back to contract formatting when only a multiplier is present", () => {
    expect(resolveAssetDisplayKind({ multiplier: 100 })).toBe("contract");
  });
});

describe("formatMarketQuantity", () => {
  test("preserves additional FX precision while trimming trailing zeroes", () => {
    expect(formatMarketQuantity(-351957.025, { isCashBalance: true })).toBe("-351,957.025");
    expect(formatMarketQuantity(-303029.144938754, { isCashBalance: true })).toBe("-303,029.144939");
  });

  test("shows whole equities without decimals and fractional equities with up to four decimals", () => {
    expect(formatMarketQuantity(10, { assetCategory: "STK" })).toBe("10");
    expect(formatMarketQuantity(10.125, { assetCategory: "STK" })).toBe("10.125");
    expect(formatMarketQuantity(10.123456, { assetCategory: "STK" })).toBe("10.1235");
  });

  test("uses higher precision for crypto quantities", () => {
    expect(formatMarketQuantity(0.123456789, { assetCategory: "CRYPTO" })).toBe("0.12345679");
  });
});

describe("formatMarketPrice", () => {
  test("uses semantic precision for equities, cash, and crypto", () => {
    expect(formatMarketPrice(190.2, { assetCategory: "STK" })).toBe("190.2");
    expect(formatMarketPrice(259.7499, { assetCategory: "STK" })).toBe("259.75");
    expect(formatMarketPrice(1.084567, { isCashBalance: true })).toBe("1.084567");
    expect(formatMarketPrice(1.17364, { assetCategory: "CURRENCY" })).toBe("1.17364");
    // Float32 provider rates: the seventh significant digit ends the display.
    expect(formatMarketPrice(157.8800048828125, { assetCategory: "CURRENCY" })).toBe("157.88");
    expect(formatMarketPrice(0.000123456789, { assetCategory: "CRYPTO" })).toBe("0.00012346");
  });

  test("scales crypto precision by magnitude instead of always spending eight decimals", () => {
    expect(formatMarketPrice(109556.1640625, { assetCategory: "CRYPTO" })).toBe("109,556.16");
    expect(formatMarketPrice(118531.39161566, { assetCategory: "CRYPTO" })).toBe("118,531.39");
    expect(formatMarketPrice(3421.8843212, { assetCategory: "CRYPTO" })).toBe("3,421.88");
    expect(formatMarketPrice(2.44190216, { assetCategory: "CRYPTO" })).toBe("2.4419");
    expect(formatMarketPrice(0.8618999719619751, { assetCategory: "CRYPTO" })).toBe("0.86189997");
    expect(formatMarketPrice(0.00000526, { assetCategory: "CRYPTO" })).toBe("0.00000526");
  });

  test("keeps tiny nonzero quotes, ranges and signed changes meaningful without asset metadata", () => {
    expect(formatMarketPriceWithCurrency(0.000005100000180391362, "USD")).toBe("$0.0000051");
    expect(formatMarketPriceWithCurrency(0.000005259999852569308, "USD")).toBe("$0.00000526");
    expect(formatSignedMarketPrice(-0.00000015256411960863806)).toBe("-0.0000001526");
    expect(formatMarketPrice(0.0000051, { maxWidth: 7 })).toBe("5.1e-6");
    expect(formatMarketPrice(1.234e-25)).toBe("1.234e-25");
    expect(formatMarketPrice(0)).toBe("0");
    expect(formatMarketPriceWithCurrency(0, "USD")).toBe("$0");
  });

  test("can adapt chart precision to the visible price range", () => {
    expect(formatMarketPrice(1.167815, { assetCategory: "CURRENCY", priceRange: 0.12 })).toBe("1.17");
    expect(formatMarketPrice(1.167815, { assetCategory: "CURRENCY", priceRange: 0.0024 })).toBe("1.1678");
    expect(formatMarketPrice(259.7499, {
      assetCategory: "STK",
      minimumFractionDigits: 2,
      precisionOffset: 1,
      priceRange: 80,
    })).toBe("259.75");
  });

  test("can lock price displays to a specific number of decimals", () => {
    expect(formatMarketPrice(18, { assetCategory: "STK", fixedFractionDigits: 1 })).toBe("18.0");
    expect(formatMarketPriceWithCurrency(18, "USD", { assetCategory: "STK", fixedFractionDigits: 2 })).toBe("$18.00");
  });

  test("fits within the supplied width before falling back to truncation elsewhere", () => {
    expect(formatMarketPrice(1.084567, { isCashBalance: true, maxWidth: 6 })).toBe("1.0846");
    expect(formatMarketQuantity(123456.789, { assetCategory: "CRYPTO", maxWidth: 7 })).toBe("123,457");
  });

  test("formats signed price changes without double signs", () => {
    expect(formatSignedMarketPrice(0.123456, { isCashBalance: true })).toBe("+0.123456");
    expect(formatSignedMarketPrice(-0.123456, { isCashBalance: true })).toBe("-0.123456");
  });
});

describe("formatMarketCost", () => {
  test("keeps equity cost displays conservative while preserving FX and crypto precision", () => {
    expect(formatMarketCost(119.3687, { assetCategory: "STK" })).toBe("119.37");
    expect(formatMarketCost(1.084567, { isCashBalance: true })).toBe("1.084567");
    expect(formatMarketCost(113905.720075, { assetCategory: "CRYPTO" })).toBe("113,905.720075");
  });
});

describe("formatMarketPriceWithCurrency", () => {
  test("renders price-like values with a symbol and variable decimals", () => {
    expect(formatMarketPriceWithCurrency(190.25, "USD", { assetCategory: "STK" })).toBe("$190.25");
    expect(formatMarketPriceWithCurrency(1.084567, "EUR", { isCashBalance: true })).toBe("€1.084567");
    expect(formatMarketPriceWithCurrency(1.17364, "USD", { assetCategory: "CURRENCY" })).toBe("$1.17364");
  });

  test("preserves chart-style compact notation for large values", () => {
    expect(formatCompactMarketPriceWithCurrency(21_970, "JPY")).toBe("¥22.0K");
    expect(formatCompactMarketPriceWithCurrency(12_340, "HKD")).toBe("HK$12.3K");
    expect(formatCompactMarketPriceWithCurrency(79_432.18, "USD", { assetCategory: "CRYPTO" })).toBe("$79.4K");
  });

  test("keeps full price precision for legend-style values", () => {
    expect(formatMarketPriceWithCurrency(79_432.18, "USD", { assetCategory: "CRYPTO" })).toBe("$79,432.18");
    expect(formatMarketPriceWithCurrency(79_432.18, "USD", { assetCategory: "STK" })).toBe("$79,432.18");
    expect(formatMarketPriceWithCurrency(1.084567, "USD", { isCashBalance: true })).toBe("$1.084567");
  });

  test("formats position cost values with tighter equity precision", () => {
    expect(formatMarketCostWithCurrency(119.3687, "HKD", { assetCategory: "STK" })).toBe("HK$119.37");
    expect(formatMarketCostWithCurrency(50.9507, "USD", { assetCategory: "OPT", multiplier: 100 })).toBe("$50.9507");
  });
});

test("nominal quantity and percent-of-par prices retain their units in narrow existing cells", () => {
  const options = { assetCategory: "BOND", priceBasis: "percent-of-par" as const };
  expect(formatMarketQuantity(1000, { ...options, quantityCurrency: "EUR", maxWidth: 11 })).toBe("1k EUR face");
  expect(formatMarketQuantity(1000, { ...options, maxWidth: 8 })).toBe("1k face");
  expect(formatMarketPriceWithCurrency(86.359375, "EUR", { ...options, maxWidth: 9 })).toBe("86.4% par");
  expect(formatMarketCostWithCurrency(87.742, "USD", options)).toBe("87.74% par");
  expect(formatMarketPriceWithCurrency(86.359375, "EUR", { assetCategory: "BOND" })).toBe("—");
});

// Metadata is descriptive, while the quote declares the price convention.
test("quote formatting uses metadata only to withhold unknown bond units", () => {
  const unknown = quoteFormatOptions({}, "BOND", "STK");
  expect(formatMarketPriceWithCurrency(87, "USD", unknown)).toBe("—");
  expect(formatMarketChangeWithCurrency(1, "USD", unknown)).toBe("—");
  const declared = quoteFormatOptions({ instrumentType: "STK" }, "BOND", "BOND");
  expect(formatMarketPriceWithCurrency(87, "USD", declared)).toBe("$87");
  expect(formatMarketChangeWithCurrency(-1, "USD", declared)).toBe("-$1.00");
  const par = quoteFormatOptions({ priceBasis: "percent-of-par" }, "STK");
  expect(formatMarketChangeWithCurrency(-1, "USD", par)).toBe("-1% par");
  // A sub-cent coin's whole day move must not round to -$0.00.
  const crypto = { assetCategory: "CRYPTOCURRENCY" };
  expect(formatMarketChangeWithCurrency(-2.6955e-8, "USD", crypto, 6.312e-6)).toBe("-$0.00000002696");
  expect(formatMarketChangeWithCurrency(-0.37, "USD", crypto, 109556.16)).toBe("-$0.37");
  // Float residue from price - previousClose on a cent-quoted asset stays $0.00.
  const stock = { assetCategory: "STK" };
  expect(formatMarketChangeWithCurrency(1.52587890625e-5, "USD", stock, 259.75)).toBe("$0.00");
  expect(formatMarketChangeWithCurrency(-2.842170943040401e-14, "USD", stock, 172.47)).toBe("$0.00");
  expect(formatMarketChangeWithCurrency(1.52587890625e-5, "USD", stock, 0.5)).toBe("$0.00");
  expect(formatMarketChangeWithCurrency(3e-14, "USD", crypto, 6.312e-6)).toBe("$0.00");
});

test("contract price precision does not change units, signed/zero/missing semantics, quantity or cost", () => {
  for (const assetCategory of ["FUT", "FUTURE", "FUTURES", "FOP", "OPT"]) {
    const options = { assetCategory };
    expect(formatMarketPriceWithCurrency(1.17485, "USD", options)).toBe("$1.17485");
    expect(formatMarketChangeWithCurrency(-0.0000005, "USD", options)).toBe("-$0.0000005");
    expect(formatMarketChangeWithCurrency(0, "USD", options)).toBe("$0.00");
    expect(formatMarketChangeWithCurrency(undefined, "USD", options)).toBe("—");
    expect(formatMarketChangeWithCurrency(NaN, "USD", options)).toBe("—");
    expect(formatMarketPriceWithCurrency(-37.63, "USD", options)).toBe("-$37.63");
    expect(formatMarketChangeWithCurrency(.25, "USX", options)).toContain("USX");
    expect(formatMarketQuantity(1.123456, options)).toBe("1.1235");
    expect(formatMarketCost(1.123456, options)).toBe("1.1235");
  }
  expect(formatMarketPriceWithCurrency(259.7499, "USD", { assetCategory: "STK" })).toBe("$259.75");
  expect(formatMarketChangeWithCurrency(1, "USD", { assetCategory: "STK" })).toBe("+$1.00");
  expect(formatMarketChangeWithCurrency(.001, "USD", { assetCategory: "BOND" })).toBe("—");
});

test("untyped observations retain source decimals with bounded widths and missing/zero distinctions", () => {
  expect(formatPriceObservation(-37.63001)).toBe("-37.63001");
  expect(formatPriceObservation(0, { minimumFractionDigits: 2 })).toBe("0.00");
  expect(formatPriceObservation(NaN)).toBe("—");
  expect(formatPriceObservation(Infinity)).toBe("—");
  expect(formatPriceObservation(.0123456)).toBe("0.0123456");
  expect(formatPriceObservation(1.1602274179458618)).toBe("1.16022742");
  expect(formatPriceObservation(.0062825, { maxWidth: 10 })).toBe("0.0062825");
  expect(formatPriceObservation(.0000051, { maxWidth: 7 })).toBe("5.1e-6");
  expect(formatPriceObservation(1.234e-25, { maxWidth: 10 })).toBe("1.234e-25");
  expect(formatPriceObservation(1234567.891, { maxWidth: 8 }).length).toBeLessThanOrEqual(8);
});
