import { expect, test } from "bun:test";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import type { Quote } from "../../../types/financials";
import { fxLegQuoteKey, fxLegs, fxLegsBehind } from "./live-legs";

const NOW = Date.UTC(2026, 9, 8, 14);
const STARTED = NOW - 60_000;

function quoteEntry(overrides: Partial<Quote>): QueryEntry<Quote> {
  const quote = { symbol: "KRW=X", price: 1340, currency: "KRW", change: 0, changePercent: 0, lastUpdated: NOW, receivedAt: NOW, marketState: "REGULAR", ...overrides } as Quote;
  return { ...createIdleEntry<Quote>(), phase: "ready", data: quote, lastGoodData: quote, fetchedAt: quote.receivedAt ?? null };
}

test("a thin pair that stopped ticking is the only leg a reload stands in for", () => {
  const legs = fxLegs(["USD", "EUR", "KRW", "NGN", "KES"]);
  const [eur, krw, ngn, kes] = legs.map(fxLegQuoteKey);
  const entries = new Map([
    [eur!, quoteEntry({ symbol: "EURUSD=X" })],
    // Silent for longer than an open market allows.
    [krw!, quoteEntry({ receivedAt: NOW - 10 * 60_000 })],
    // A snapshot another pane loaded before this board subscribed is not the feed.
    [ngn!, quoteEntry({ receivedAt: STARTED - 1000 })],
    [kes!, quoteEntry({ stale: true })],
  ]);
  const feed = { liveStreaming: true, liveCurrencies: new Set<string>(), startedAt: STARTED, now: NOW };
  expect(fxLegsBehind(legs, entries, feed)).toEqual(["KRW", "NGN", "KES"]);
  // With streaming off, the legs' own quote poll is the feed: a leg counts once it has drawn a rate since.
  expect(fxLegsBehind(legs, entries, { ...feed, liveStreaming: false, liveCurrencies: new Set(["EUR", "NGN", "KES"]) }))
    .toEqual(["KRW", "NGN"]);
});
