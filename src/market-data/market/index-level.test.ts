import { expect, test } from "bun:test";
import { formatMarketPriceWithCurrency } from "./format";
import { INDEX_POINTS_UNIT, priceSeriesUnit, quotePriceCurrency, reportedQuoteVolume } from "./index-level";

test("an index level is points with no currency, by its type however a source spells it, and a stock keeps its currency", () => {
  for (const instrumentType of ["INDEX", "index", "IND"]) {
    expect(quotePriceCurrency({ currency: "USD", instrumentType })).toBeNull();
    expect(priceSeriesUnit("USD", instrumentType)).toBe(INDEX_POINTS_UNIT);
    expect(formatMarketPriceWithCurrency(19.99, "USD", { assetCategory: instrumentType })).toBe("19.99");
  }
  expect(quotePriceCurrency({ currency: "USD", instrumentType: "EQUITY" })).toBe("USD");
  expect(quotePriceCurrency({ currency: " ", instrumentType: "EQUITY" })).toBeNull();
  expect(priceSeriesUnit("EUR", "EQUITY")).toBe("EUR");
  expect(priceSeriesUnit("USD", undefined)).toBe("USD");
  expect(formatMarketPriceWithCurrency(343.46, "USD", { assetCategory: "EQUITY" })).toBe("$343.46");
});

test("a volume of 0 nobody counts is no volume, while a stock's 0 and an index's summed volume are kept", () => {
  // ^VIX and a crypto venue's perpetual carry 0 for a volume nobody counts.
  expect(reportedQuoteVolume({ volume: 0, instrumentType: "INDEX" })).toBeNull();
  expect(reportedQuoteVolume({ volume: 0, instrumentType: "CRYPTOCURRENCY", name: "Bitcoin USDT (Derivatives)" })).toBeNull();
  // ^GSPC's source sums its members' volume; a halted stock's session traded nothing.
  expect(reportedQuoteVolume({ volume: 2_500_000_000, instrumentType: "INDEX" })).toBe(2_500_000_000);
  expect(reportedQuoteVolume({ volume: 0, instrumentType: "EQUITY" })).toBe(0);
  expect(reportedQuoteVolume({ volume: Number.NaN, instrumentType: "EQUITY" })).toBeNull();
  expect(reportedQuoteVolume({ instrumentType: "EQUITY" })).toBeNull();
  expect(reportedQuoteVolume(null)).toBeNull();
});
