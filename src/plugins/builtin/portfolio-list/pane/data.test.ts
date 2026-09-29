import { describe, expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import {
  needsVisibleQuoteWarmup,
  needsVisibleQuoteWatchdogRefresh,
  selectQuoteWarmupTickers,
  selectStreamTickers,
  VISIBLE_QUOTE_STREAM_MAX_AGE_MS,
} from "./data";
import { createTestFinancials } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "AAPL",
    price: 100,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function financials(quoteValue: Quote): TickerFinancials {
  return createTestFinancials({ quote: quoteValue });
}

function ticker(symbol: string): TickerRecord {
  return createTestTicker(symbol);
}

describe("portfolio visible quote warmup", () => {
  test("refreshes current-session quotes once the visible-row age window expires", () => {
    const now = Date.now();
    const data = financials(quote({
      lastUpdated: now - VISIBLE_QUOTE_STREAM_MAX_AGE_MS,
      listingExchangeName: "FWB2",
      marketState: "REGULAR",
    }));

    expect(needsVisibleQuoteWarmup(data, now)).toBe(false);
    expect(needsVisibleQuoteWatchdogRefresh(data, now)).toBe(true);
  });

  test("treats stale active-session quotes as visible warmup misses", () => {
    const now = Date.parse("2026-07-07T12:10:30Z");
    const data = financials(quote({
      lastUpdated: Date.parse("2026-07-07T12:10:00Z"),
      listingExchangeName: "NASDAQ",
      marketState: "PRE",
    }));

    expect(needsVisibleQuoteWarmup(data, now)).toBe(true);
    expect(needsVisibleQuoteWatchdogRefresh(data, now)).toBe(true);
  });
});

describe("selectStreamTickers", () => {
  test("includes visible rows with overscan and clamps boundaries", () => {
    const tickers = Array.from({ length: 20 }, (_, index) => ticker(`T${index}`));
    expect(selectStreamTickers(tickers, { start: 3, end: 7 }).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(0, 13).map((entry) => entry.metadata.ticker),
    );
    expect(selectStreamTickers(tickers, { start: 18, end: 20 }).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(12, 20).map((entry) => entry.metadata.ticker),
    );
  });

  test("includes selected ticker outside the visible streaming window", () => {
    const tickers = Array.from({ length: 20 }, (_, index) => ticker(`T${index}`));
    expect(selectStreamTickers(tickers, { start: 3, end: 7 }, "T19").map((entry) => entry.metadata.ticker)).toContain("T19");
  });
});

describe("selectQuoteWarmupTickers", () => {
  test("includes hidden quote-missing rows when sorting by quote-dependent columns", () => {
    const tickers = Array.from({ length: 30 }, (_, index) => ticker(`T${index}`));
    const financialsMap = new Map<string, TickerFinancials>(
      tickers.slice(0, 29).map((entry, index) => [
        entry.metadata.ticker,
        financials({
          symbol: entry.metadata.ticker,
          price: index + 1,
          currency: "USD",
          change: index,
          changePercent: index,
          lastUpdated: 1_700_000_000_000,
        }),
      ]),
    );

    const selected = selectQuoteWarmupTickers(
      tickers,
      { start: 0, end: 24 },
      financialsMap,
      { columnId: "change_pct", direction: "asc" },
      1_700_000_010_000,
    ).map((entry) => entry.metadata.ticker);

    expect(selected).toContain("T29");
  });

  test("does not add hidden rows for ticker-only sorting", () => {
    const tickers = Array.from({ length: 30 }, (_, index) => ticker(`T${index}`));
    expect(selectQuoteWarmupTickers(
      tickers,
      { start: 0, end: 24 },
      new Map(),
      { columnId: "ticker", direction: "asc" },
    ).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(0, 24).map((entry) => entry.metadata.ticker),
    );
  });
});

describe("visible quote refresh predicates", () => {
  test("refreshes visible quotes when the local stream timestamp is too old", () => {
    const now = 1_700_000_120_000;
    expect(needsVisibleQuoteWatchdogRefresh(
      financials(quote({ lastUpdated: now, receivedAt: now - 61_000 })),
      now,
      60_000,
    )).toBe(true);
    expect(needsVisibleQuoteWatchdogRefresh(
      financials(quote({ lastUpdated: now, receivedAt: now - 10_000 })),
      now,
      60_000,
    )).toBe(false);
  });
});
