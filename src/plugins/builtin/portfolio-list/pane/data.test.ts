import { describe, expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import {
  needsVisibleQuoteWarmup,
  needsVisibleQuoteWatchdogRefresh,
  VISIBLE_QUOTE_STREAM_MAX_AGE_MS,
} from "./data";
import { createTestFinancials } from "../../../../test-support/data-provider";

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
