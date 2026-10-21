import { expect, test } from "bun:test";
import type { Quote } from "../types/financials";
import { premiumToUnderlying } from "./perpetual-premium";

test("a stock perpetual's premium is against the stock's live quote in session, and the stored figure otherwise", () => {
  const row = { markPrice: 103, priceMultiplier: 1, underlying: { currency: "USD" }, underlyingPremium: 0.01,
    equityMatch: { basis: "listing" as const } };
  const stock = { symbol: "NVDA", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now(),
    marketState: "REGULAR", dataSource: "live" } as Quote;
  expect(premiumToUnderlying(row, stock)).toBeCloseTo(0.03);
  // A delayed quote is older than the stored price; a shut market's reference is its close, which Cloud already uses.
  expect(premiumToUnderlying(row, { ...stock, dataSource: "delayed" })).toBe(0.01);
  expect(premiumToUnderlying(row, { ...stock, marketState: "POST" })).toBe(0.01);
  expect(premiumToUnderlying(row, { ...stock, currency: "EUR" })).toBe(0.01);
  expect(premiumToUnderlying(row, null)).toBe(0.01);
});

test("the stock's own quote is the reference only for a contract on that very listing", () => {
  const row = { markPrice: 103, priceMultiplier: 1, underlying: { currency: "USD" }, underlyingPremium: 0.01 };
  const stock = { symbol: "GOOG", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now(),
    marketState: "REGULAR", dataSource: "live" } as Quote;
  // A GOOGL contract seen from GOOG (or BRK.A's from BRK.B) tracks another listing's price.
  expect(premiumToUnderlying({ ...row, equityMatch: { basis: "issuer" } }, stock)).toBe(0.01);
  // A row with no match said is not assumed to be the listing's.
  expect(premiumToUnderlying(row, stock)).toBe(0.01);
  // A contract's own quote is never its reference.
  expect(premiumToUnderlying({ ...row, equityMatch: { basis: "listing" } }, { ...stock, instrumentType: "PERP" })).toBe(0.01);
});
