import { describe, expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { buildQuoteKey } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";
import {
  buildScreenerQuoteTargets,
  overlayScreenerQuoteEntries,
  resolveScreenerQuoteFeedStatus,
} from "./screener-live-quotes";

function readyEntry(quote: Quote): QueryEntry<Quote> {
  return {
    phase: "ready",
    data: quote,
    lastGoodData: quote,
    source: "gloomberb-cloud",
    fetchedAt: quote.receivedAt ?? null,
    staleAt: null,
    error: null,
    attempts: [],
  };
}

describe("screener live quotes", () => {
  test("overlays dynamic quote fields without replacing screener metadata", () => {
    const rows = [{
      symbol: "AAPL",
      name: "Apple Inc.",
      price: 190,
      change: 1,
      changePercent: 0.5,
      volume: 10,
      currency: "USD",
      exchange: "NASDAQ",
      lastUpdated: 100,
      size: 3_000_000_000_000,
    }];
    const quote: Quote = {
      symbol: "AAPL",
      price: 192,
      change: 3,
      changePercent: 1.59,
      volume: 20,
      currency: "USD",
      lastUpdated: 200,
      dataSource: "live",
    };
    const entries = new Map([
      [buildQuoteKey({ symbol: "AAPL", exchange: "NASDAQ" }), readyEntry(quote)],
    ]);

    expect(overlayScreenerQuoteEntries(rows, entries)[0]).toMatchObject({
      name: "Apple Inc.",
      price: 192,
      changePercent: 1.59,
      volume: 20,
      size: 3_000_000_000_000,
    });
  });

  test("marks complete fresh Cloud stream coverage as live", () => {
    const now = 1_000;
    const rows = [
      { symbol: "AAPL", exchange: "NASDAQ" },
      { symbol: "MSFT", exchange: "NASDAQ" },
    ];
    const targets = buildScreenerQuoteTargets(rows, "AAPL");
    const entries = new Map<string, QueryEntry<Quote>>();
    for (const row of rows) {
      const quote: Quote = {
        symbol: row.symbol,
        price: 200,
        change: 1,
        changePercent: 0.5,
        currency: "USD",
        lastUpdated: now,
        receivedAt: now,
        delivery: "stream",
        stale: false,
        dataSource: "live",
      };
      entries.set(buildQuoteKey(row), readyEntry(quote));
    }

    expect(targets[0]).toMatchObject({ selected: true, weight: 100 });
    expect(resolveScreenerQuoteFeedStatus(targets, entries, {
      now,
      subscriptionStartedAt: 900,
    })).toBe("live");
  });

  test("reports nothing while the stream is still connecting", () => {
    const targets = buildScreenerQuoteTargets([{ symbol: "AAPL", exchange: "NASDAQ" }], null);
    const entries = new Map<string, QueryEntry<Quote>>();
    expect(resolveScreenerQuoteFeedStatus(targets, entries, { now: 1_000, subscriptionStartedAt: 900 })).toBeNull();
    expect(resolveScreenerQuoteFeedStatus(targets, entries, { now: 60_000, subscriptionStartedAt: 900 })).toBe("polling");
  });
});

test("replacement snapshots clear unavailable fields and select only the qualified listing", () => {
  const rows = [{ symbol: "ACME", exchange: "NASDAQ", name: "US", currency: "USD", price: 10, change: 1, changePercent: 10, volume: 200, lastUpdated: 100 },
    { symbol: "ACME", exchange: "LSE", name: "UK", currency: "GBP", price: 8, change: 0, changePercent: 0, volume: 0, lastUpdated: 100 }];
  const targets = buildScreenerQuoteTargets(rows, "ACME:XLON");
  expect(targets.map(target => target.selected)).toEqual([false, true]);
  const entries = new Map([[buildQuoteKey(rows[0]!), readyEntry({ symbol: "ACME", price: 12, currency: "USD", lastUpdated: 200 })]]);
  expect(overlayScreenerQuoteEntries(rows, entries)).toEqual([
    expect.objectContaining({ price: 12, change: null, changePercent: null, volume: null, lastUpdated: 200 }), rows[1]!,
  ]);
  entries.set(buildQuoteKey(rows[0]!), readyEntry({ symbol: "ACME", price: 12, currency: "USD", lastUpdated: 50, change: 0, changePercent: 0, volume: 0 }));
  expect(overlayScreenerQuoteEntries(rows, entries)).toEqual(rows);
});
