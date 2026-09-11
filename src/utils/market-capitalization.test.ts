import { expect, test } from "bun:test";
import { selectMarketCapitalization, describeFundamentalMarketCap } from "./market-capitalization";
import type { Quote } from "../types/financials";

const quote: Quote = { symbol: "F:XNYS", price: 14.01, currency: "USD", change: 0, changePercent: 0,
  lastUpdated: Date.parse("2026-09-11T15:30:00Z"), providerId: "yahoo" };
const fundamentals = { marketCap: 55_866_216_448, marketCapCurrency: "USD", source: "yahoo" as const,
  fetchedAt: "2026-09-11T15:23:57.311Z", financialCurrency: "USD", freeCashFlow: -7_940_250_112, stale: false };

test("a lightweight quote preserves the separately sourced capitalization and retrieval time", () => {
  const selected = selectMarketCapitalization(quote, fundamentals)!;
  expect(selected).toEqual({ value: fundamentals.marketCap, currency: "USD",
    provenance: { kind: "fundamentals", source: "yahoo", retrievedAt: fundamentals.fetchedAt, stale: false } });
  expect(describeFundamentalMarketCap(selected.provenance)).toContain("retrieved 2026-09-11 15:23:57 UTC");
  expect(describeFundamentalMarketCap(selected.provenance)).toContain("valuation date unavailable");
  expect(selectMarketCapitalization(undefined, fundamentals)).toEqual(selected);
  expect(quote.marketCap).toBeUndefined();
});

test("a valid quote capitalization wins without borrowing the fallback currency or retrieval time", () => {
  expect(selectMarketCapitalization({ ...quote, marketCap: 60e9 }, { ...fundamentals, marketCapCurrency: "EUR" }))
    .toEqual({ value: 60e9, currency: "USD", provenance: { kind: "quote", source: "yahoo" } });
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
