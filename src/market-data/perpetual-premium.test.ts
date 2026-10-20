import { expect, test } from "bun:test";
import type { Quote } from "../types/financials";
import { premiumToUnderlying } from "./perpetual-premium";

test("a stock perpetual's premium is against the stock's live quote in session, and the stored figure otherwise", () => {
  const row = { markPrice: 103, priceMultiplier: 1, underlying: { currency: "USD" }, underlyingPremium: 0.01 };
  const stock = { symbol: "NVDA", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now(),
    marketState: "REGULAR", dataSource: "live" } as Quote;
  expect(premiumToUnderlying(row, stock)).toBeCloseTo(0.03);
  // A delayed quote is older than the stored price; a shut market's reference is its close, which Cloud already uses.
  expect(premiumToUnderlying(row, { ...stock, dataSource: "delayed" })).toBe(0.01);
  expect(premiumToUnderlying(row, { ...stock, marketState: "POST" })).toBe(0.01);
  expect(premiumToUnderlying(row, { ...stock, currency: "EUR" })).toBe(0.01);
  expect(premiumToUnderlying(row, null)).toBe(0.01);
});
