import { expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../../../types/financials";
import { relativeValuationValues, withLiveQuote } from "./relative-valuation-model";

const snapshot: TickerFinancials = {
  annualStatements: [],
  quarterlyStatements: [],
  priceHistory: [],
  quote: { symbol: "PLD", price: 100, change: 1, changePercent: 1, currency: "USD", lastUpdated: 1_000, marketCap: 1_000 },
  fundamentals: { trailingPE: 20, forwardPE: 16, freeCashFlow: 50, financialCurrency: "USD" },
};

function live(overrides: Partial<Quote>): Quote {
  return { symbol: "PLD", price: 110, change: 11, changePercent: 11, currency: "USD", lastUpdated: 2_000, ...overrides };
}

test("a live quote moves price-based values with the price and keeps the fundamentals", () => {
  const values = relativeValuationValues(withLiveQuote(snapshot, live({})));
  expect(values.price).toBe(110);
  expect(values.changePercent).toBe(11);
  expect(values.marketCap).toBeCloseTo(1_100);
  expect(values.fcfYield).toBeCloseTo(50 / 1_100);
  expect(values.reportedMultiples.trailingPE).toBeCloseTo(22);
  expect(values.reportedMultiples.forwardPE).toBeCloseTo(17.6);
});

test("an older, stale or differently priced quote leaves the snapshot alone", () => {
  for (const quote of [live({ lastUpdated: 500 }), live({ stale: true }), live({ currency: "EUR" })]) {
    expect(withLiveQuote(snapshot, quote)).toBe(snapshot);
  }
});

test("values measured at a stale price or from stale fundamentals do not scale", () => {
  const staleFundamentals = { ...snapshot, fundamentals: { ...snapshot.fundamentals!, stale: true } };
  const fromStaleFundamentals = relativeValuationValues(withLiveQuote(staleFundamentals, live({})));
  expect(fromStaleFundamentals.price).toBe(110);
  expect(fromStaleFundamentals.marketCap).toBeCloseTo(1_100);
  expect(fromStaleFundamentals.reportedMultiples.trailingPE).toBe(20);

  const staleQuote = {
    ...snapshot,
    quote: { ...snapshot.quote!, stale: true },
    fundamentals: { ...snapshot.fundamentals!, marketCap: 900, marketCapCurrency: "USD" },
  };
  const fromStaleQuote = relativeValuationValues(withLiveQuote(staleQuote, live({})));
  expect(fromStaleQuote.price).toBe(110);
  expect(fromStaleQuote.marketCap).toBe(900);
  expect(fromStaleQuote.reportedMultiples.trailingPE).toBe(20);
});
