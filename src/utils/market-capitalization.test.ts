import { expect, test } from "bun:test";
import { marketCapBasisNote, selectMarketCapitalization, describeFundamentalMarketCap, viewMarketCapitalization } from "./market-capitalization";
import type { Quote } from "../types/financials";

const quote: Quote = { symbol: "F:XNYS", price: 14.01, currency: "USD", change: 0, changePercent: 0,
  lastUpdated: Date.parse("2026-09-11T15:30:00Z"), providerId: "gloom" };
const fundamentals = { marketCap: 55_866_216_448, marketCapCurrency: "USD", source: "gloom" as const,
  fetchedAt: "2026-09-11T15:23:57.311Z", financialCurrency: "USD", freeCashFlow: -7_940_250_112, stale: false };

test("a lightweight quote preserves the separately sourced capitalization and retrieval time", () => {
  const selected = selectMarketCapitalization(quote, fundamentals)!;
  expect(selected).toEqual({ value: fundamentals.marketCap, currency: "USD",
    provenance: { kind: "fundamentals", source: "gloom", retrievedAt: fundamentals.fetchedAt, stale: false } });
  expect(describeFundamentalMarketCap(selected.provenance)).toContain("retrieved 2026-09-11 15:23:57 UTC");
  expect(describeFundamentalMarketCap(selected.provenance)).toContain("valuation date unavailable");
  expect(selectMarketCapitalization(undefined, fundamentals)).toEqual(selected);
  expect(quote.marketCap).toBeUndefined();
});

test("a valid quote capitalization wins without borrowing the fallback currency or retrieval time", () => {
  expect(selectMarketCapitalization({ ...quote, marketCap: 60e9 }, { ...fundamentals, marketCapCurrency: "EUR" }))
    .toEqual({ value: 60e9, currency: "USD", provenance: { kind: "quote", source: "gloom" } });
  expect(selectMarketCapitalization({ ...quote, marketCap: 0 }, fundamentals)?.value).toBe(0);
});

test.each([undefined, "", "GBp"])("unknown or unnormalized capitalization currency %s is not inferred from a USD quote", (marketCapCurrency) => {
  expect(selectMarketCapitalization(quote, { ...fundamentals, marketCapCurrency })).toBeNull();
});

test.each([NaN, Infinity, -1])("unusable capitalization %s is not ranked", (marketCap) => {
  expect(selectMarketCapitalization({ ...quote, marketCap }, { ...fundamentals, marketCap })).toBeNull();
});

test("stale and undated fundamental provenance remains explicit", () => {
  const selected = selectMarketCapitalization(quote, { ...fundamentals, fetchedAt: undefined, stale: true })!;
  expect(describeFundamentalMarketCap(selected.provenance)).toContain("retrieval time unavailable, stale");
  expect(selected.provenance.retrievedAt).toBeUndefined();
});

// One basis for valuation, RV and EQS: shares x price while the provider's cap can be on the same count
// (price timing, a recent issuance), named when more than 2% off; past 10% the count shown is another one (one
// class's) and the provider's stands.
test("a view's cap is the share count times the price within 10% of the provider's, and the provider's past it", () => {
  // 1B shares at 10 USD: 10B.
  const view = (marketCap: number) => viewMarketCapitalization({ ...quote, marketCap, price: 10 }, { ...fundamentals, sharesOutstanding: 1e9 });
  expect(view(10.2e9)).toEqual({ value: 10e9, currency: "USD", provenance: { kind: "quote", source: "gloom" } });
  expect(marketCapBasisNote(view(10.2e9))).toBeUndefined();
  // Exactly 10% either way is still the product.
  for (const providerValue of [11e9, 9e9]) {
    expect(view(providerValue)).toMatchObject({ value: 10e9, computed: { shares: 1e9, price: 10, providerValue } });
  }
  expect(marketCapBasisNote(view(11e9))).toBe("Market cap 10B USD is the 1B shares shown x 10.00 USD; the provider's is 11B USD.");
  // Just past 10%, the provider's, with the count it does not rest on.
  expect(view(11.01e9)).toMatchObject({ value: 11.01e9, otherBasis: { shares: 1e9, price: 10, product: 10e9 } });
  expect(view(11.01e9).computed).toBeUndefined();
  expect(marketCapBasisNote(view(11.01e9))).toBe("Market cap 11.01B USD is the provider's and does not rest on the 1B shares shown (x 10.00 USD = 10B).");
});
