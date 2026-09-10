import { describe, expect, test } from "bun:test";
import {
  formatMarketCost,
  formatMarketCostWithCurrency,
  formatCompactMarketPriceWithCurrency,
  formatMarketPrice,
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
    expect(formatMarketPrice(0.000123456789, { assetCategory: "CRYPTO" })).toBe("0.00012346");
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
