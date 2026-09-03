import { describe, expect, test } from "bun:test";
import { appendLiveQuotePoint } from "./chart-data";
import type { PricePoint, Quote } from "../types/financials";

function quoteFixture(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "INTC",
    price: 129,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.parse("2026-05-15T20:30:00Z"),
    listingExchangeName: "NASDAQ",
    marketState: "REGULAR",
    ...overrides,
  };
}

describe("appendLiveQuotePoint", () => {
  test("extends coarse chart histories with a fresh quote tail", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-04T00:00:00Z"), close: 56 },
      { date: new Date("2026-05-11T00:00:00Z"), close: 68 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture(),
      { now: Date.parse("2026-05-15T21:00:00Z") },
    );

    expect(extended).toHaveLength(3);
    expect(extended.at(-1)).toEqual({
      date: new Date("2026-05-15T20:30:00Z"),
      close: 129,
    });
  });

  test("merges a quote into the active OHLC bucket", () => {
    const history: PricePoint[] = [
      {
        date: new Date("2026-05-15T20:25:00Z"),
        open: 124,
        high: 130,
        low: 122,
        close: 126,
        volume: 1_000,
      },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-05-15T20:29:00Z") }),
      {
        now: Date.parse("2026-05-15T20:30:00Z"),
        mode: "ohlc",
        resolution: "5m",
      },
    );

    expect(extended).toHaveLength(1);
    expect(extended[0]).toEqual({
      date: new Date("2026-05-15T20:25:00Z"),
      open: 124,
      high: 130,
      low: 122,
      close: 129,
      volume: 1_000,
    });
  });

  test("seeds a new OHLC bucket from the live price instead of prior-bar extremes", () => {
    const history: PricePoint[] = [
      {
        date: new Date("2026-05-15T20:25:00Z"),
        open: 124,
        high: 180,
        low: 80,
        close: 126,
        volume: 1_000,
      },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-05-15T20:30:00Z") }),
      {
        now: Date.parse("2026-05-15T20:31:00Z"),
        mode: "ohlc",
        resolution: "5m",
      },
    );

    expect(extended).toHaveLength(2);
    expect(extended[1]).toEqual({
      date: new Date("2026-05-15T20:30:00Z"),
      open: 129,
      high: 129,
      low: 129,
      close: 129,
    });
  });

  test("treats calendar-month bars as variable-length buckets", () => {
    const history: PricePoint[] = [{
      date: new Date("2026-01-01T00:00:00Z"),
      open: 120,
      high: 140,
      low: 110,
      close: 125,
    }];

    const endOfJanuary = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-01-31T20:30:00Z") }),
      {
        now: Date.parse("2026-01-31T20:31:00Z"),
        mode: "ohlc",
        resolution: "1mo",
      },
    );
    const startOfFebruary = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-02-01T20:30:00Z") }),
      {
        now: Date.parse("2026-02-01T20:31:00Z"),
        mode: "ohlc",
        resolution: "1mo",
      },
    );

    expect(endOfJanuary).toHaveLength(1);
    expect(endOfJanuary[0]?.close).toBe(129);
    expect(startOfFebruary).toHaveLength(2);
    expect(startOfFebruary[1]).toMatchObject({
      open: 129,
      high: 129,
      low: 129,
      close: 129,
    });
  });

  test("uses the active extended-hours price for the live tail", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-15T19:30:00Z"), close: 128 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({
        marketState: "POST",
        postMarketPrice: 131,
        lastUpdated: Date.parse("2026-05-15T21:10:00Z"),
      }),
      { now: Date.parse("2026-05-15T21:15:00Z") },
    );

    expect(extended.at(-1)?.close).toBe(131);
  });

  test("does not bridge a missing intraday history window with one synthetic candle", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-07-22T14:49:00Z"), close: 347.73 },
      { date: new Date("2026-07-22T14:50:00Z"), close: 347.76 },
      { date: new Date("2026-07-22T14:51:00Z"), close: 347.68 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({
        symbol: "GOOG",
        price: 346.27,
        lastUpdated: Date.parse("2026-07-22T18:52:00Z"),
      }),
      Date.parse("2026-07-22T18:53:00Z"),
    );

    expect(extended).toBe(history);
  });

  test("does not append a live quote tail with a likely unit mismatch", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-18T00:00:00Z"), close: 405 },
      { date: new Date("2026-05-22T00:00:00Z"), close: 379 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({
        symbol: "FTC",
        currency: "GBP",
        price: 3.79,
        lastUpdated: Date.parse("2026-05-22T16:39:00Z"),
      }),
      { now: Date.parse("2026-05-22T16:45:00Z") },
    );

    expect(extended).toBe(history);
  });

  test("does not append stale quotes from an older active session", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-11T00:00:00Z"), close: 68 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({
        lastUpdated: Date.parse("2026-05-08T20:00:00Z"),
      }),
      { now: Date.parse("2026-05-15T15:00:00Z") },
    );

    expect(extended).toBe(history);
  });
});
