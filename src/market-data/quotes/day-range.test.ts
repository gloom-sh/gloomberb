import { expect, test } from "bun:test";
import type { Quote } from "../../types/financials";
import { mapQuote } from "../../sources/gloomberb-cloud/normalizers";
import { mergeQuoteContribution, normalizeQuoteContribution } from "./contributions";
import { reconcileQuoteDayRange } from "./day-range";
import { resolveCanonicalQuote } from "./resolution";

const now = Date.parse("2026-09-10T15:00:00Z");
function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "NVDA", providerId: "gloomberb-cloud", price: 219, currency: "USD",
    change: 0, changePercent: 0, lastUpdated: now,
    listingExchangeName: "NASDAQ", marketState: "REGULAR", sessionConfidence: "explicit",
    high: 220.99, low: 218.05,
    ...overrides,
  };
}

test("cloud snapshots include the latest regular trade beyond a lagging daily bar", () => {
  // The production Alpaca quote had no venue, only an explicit session date.
  const nvda = mapQuote(quote({ price: 217.77, low: 217.79, listingExchangeName: undefined,
    sessionConfidence: "derived", changeSessionDate: "2026-09-10" }));
  expect(nvda).toMatchObject({ high: 220.99, low: 217.77 });
  const contribution = normalizeQuoteContribution(nvda)!;
  expect(resolveCanonicalQuote({ "gloomberb-cloud": contribution }, now).quote?.changeSessionDate).toBe("2026-09-10");
  expect(mergeQuoteContribution(contribution, { ...nvda, price: 217, high: undefined, low: undefined }))
    .toMatchObject({ high: 220.99, low: 217 });
  expect(mapQuote(quote({ price: 222 }))).toMatchObject({ high: 222, low: 218.05 });
  // Apply the same correction after converting London pence to pounds.
  expect(mapQuote(quote({ currency: "GBp", listingExchangeName: "LSE", price: 230, high: 225, low: 210 })))
    .toMatchObject({ currency: "GBP", price: 2.3, high: 2.3, low: 2.1 });
});

test("sparse regular ticks widen cached extrema and later snapshots cannot shrink them", () => {
  const current = normalizeQuoteContribution(quote())!;
  const tick = quote({ price: 217.87, high: undefined, low: undefined, lastUpdated: now + 1_000 });
  const lower = mergeQuoteContribution(current, tick);
  expect(lower).toMatchObject({ high: 220.99, low: 217.87 });
  const rebound = mergeQuoteContribution(lower, quote({ price: 222, high: undefined, low: undefined, lastUpdated: now + 2_000 }));
  const delayedBar = mergeQuoteContribution(rebound, quote({ price: 221, high: 221, low: 218, lastUpdated: now + 3_000 }));
  expect(delayedBar).toMatchObject({ high: 222, low: 217.87 });
  expect(resolveCanonicalQuote({ "gloomberb-cloud": delayedBar }, now + 4_000).quote)
    .toMatchObject({ price: 221, high: 222, low: 217.87 });
});

test("after-hours and unknown-session ticks do not widen the regular-session range", () => {
  const current = normalizeQuoteContribution(quote())!;
  for (const marketState of ["PRE", "POST", "CLOSED", undefined] as const) {
    const tick = quote({ price: 250, marketState, sessionConfidence: marketState ? "explicit" : undefined, high: undefined, low: undefined });
    const merged = mergeQuoteContribution(current, tick);
    expect(merged).toMatchObject({ high: 220.99, low: 218.05 });
    expect(normalizeQuoteContribution(merged)).toMatchObject({ high: 220.99, low: 218.05 });
  }
});

test("a new session, listing, or currency cannot inherit previous extrema", () => {
  const current = normalizeQuoteContribution(quote())!;
  for (const overrides of [
    { lastUpdated: now + 86_400_000 },
    { currency: "EUR" },
    { listingExchangeName: "LSE" },
    { listingExchangeName: undefined },
    { symbol: "NVDA:XLON" },
  ]) {
    const next = quote({ price: 219, high: undefined, low: undefined, ...overrides });
    expect(mergeQuoteContribution(current, next)).toMatchObject({ high: undefined, low: undefined });
  }
  const pence = normalizeQuoteContribution(quote({ currency: "GBp", price: 21900, low: 21805, high: 22099 }))!;
  expect(mergeQuoteContribution(pence, quote({ currency: "GBP", high: undefined, low: undefined })))
    .toMatchObject({ high: undefined, low: undefined });
});

test("missing or untrusted ranges do not become an invented full-day range", () => {
  expect(reconcileQuoteDayRange(quote({ high: undefined, low: undefined })))
    .toMatchObject({ high: undefined, low: undefined });
  expect(reconcileQuoteDayRange(quote({ price: 222, stale: true })))
    .toMatchObject({ high: 220.99, low: 218.05 });
  expect(reconcileQuoteDayRange(quote({ price: 21900 })))
    .toMatchObject({ high: 220.99, low: 218.05 });
  expect(reconcileQuoteDayRange(quote({ price: 222, changeSessionDate: "2026-09-09" })))
    .toMatchObject({ high: 220.99, low: 218.05 });
  expect(reconcileQuoteDayRange(quote({ price: 222, listingExchangeName: undefined, changeSessionDate: "2026-02-30" })))
    .toMatchObject({ high: 220.99, low: 218.05 });
});
