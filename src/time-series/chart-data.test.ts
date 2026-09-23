import { describe, expect, test } from "bun:test";
import { resetServerClockForTests, setForwardedServerClockOffset } from "../market-data/quotes/clock";
import { appendLiveQuotePoint } from "./chart-data";
import type { PricePoint, Quote } from "../types/financials";

function quoteFixture(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "INTC",
    price: 129,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.parse("2026-05-15T19:30:00Z"),
    listingExchangeName: "NASDAQ",
    marketState: "REGULAR",
    ...overrides,
  };
}

describe("appendLiveQuotePoint", () => {
  test("follows quotes from a server clock measured more than five minutes ahead", () => {
    const now = Date.parse("2026-05-15T19:30:00Z");
    const history: PricePoint[] = [
      { date: new Date("2026-05-15T19:34:00Z"), close: 128 },
      { date: new Date("2026-05-15T19:35:00Z"), close: 128.5 },
    ];
    const quote = quoteFixture({ lastUpdated: Date.parse("2026-05-15T19:36:00Z") });
    try {
      expect(appendLiveQuotePoint(history, quote, { now })).toBe(history);
      setForwardedServerClockOffset(6 * 60_000);
      expect(appendLiveQuotePoint(history, quote, { now }).at(-1)).toEqual({ date: new Date("2026-05-15T19:36:00Z"), close: 129 });
    } finally {
      resetServerClockForTests();
    }
  });

  test("merges daily quote updates by session for date labels and opening timestamps", () => {
    const now = Date.parse("2026-09-10T18:44:00Z");
    const quote = quoteFixture({ price: 39.75, lastUpdated: now });
    for (const date of ["2026-09-10T00:00:00Z", "2026-09-10T13:30:00Z"]) {
      const history = [{ date: new Date(date), open: 40, high: 41, low: 39, close: 39.77, volume: 1000 }];
      const updated = appendLiveQuotePoint(history, quote, { now, mode: "ohlc", resolution: "1d" });
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ close: 39.75, open: 40, high: 41, low: 39, volume: 1000 });
      expect(history[0]?.close).toBe(39.77);
    }
  });

  test("does not merge the next premarket into yesterday's daily bar within 24 hours", () => {
    const now = Date.parse("2026-09-11T12:00:00Z");
    const history = [{ date: new Date("2026-09-10T13:30:00Z"), close: 100 }];
    const updated = appendLiveQuotePoint(history, quoteFixture({
      price: 100, preMarketPrice: 105, marketState: "PRE", lastUpdated: now,
    }), { now, mode: "ohlc", resolution: "1d" });
    expect(updated).toHaveLength(2);
    expect(updated[0]?.close).toBe(100);
    expect(updated[1]?.close).toBe(105);
  });

  test("keeps an after-hours quote in its exchange session across UTC midnight", () => {
    const now = Date.parse("2026-09-11T00:01:00Z");
    const updated = appendLiveQuotePoint([{ date: new Date("2026-09-10T00:00:00Z"), close: 100 }],
      quoteFixture({ price: 100, postMarketPrice: 105, marketState: "POST", lastUpdated: now - 60_000 }),
      { now, mode: "ohlc", resolution: "1d" });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.close).toBe(105);
  });

  test("merges a quote into a London-dated FX bar that opened at 23:00 UTC", () => {
    const now = Date.parse("2026-09-17T23:30:00Z");
    const quote = quoteFixture({
      symbol: "EURUSD=X", price: 1.149, lastUpdated: now - 60_000,
      listingExchangeName: "CCY", exchangeName: "CCY",
    });
    const history: PricePoint[] = [
      { date: new Date("2026-09-17T00:00:00Z"), open: 1.146, high: 1.148, low: 1.145, close: 1.1476 },
      { date: new Date("2026-09-18T00:00:00Z"), open: 1.1476, high: 1.1482, low: 1.1471, close: 1.148 },
    ];
    for (const resolution of ["1d", "1wk"] as const) {
      const updated = appendLiveQuotePoint(history, quote, { now, mode: "ohlc", resolution });
      expect(updated).toHaveLength(2);
      expect(updated[1]).toMatchObject({ open: 1.1476, high: 1.149, low: 1.1471, close: 1.149 });
    }
    const scalar = appendLiveQuotePoint(history.map(({ date, close }) => ({ date, close })), quote, { now });
    expect(scalar.map((point) => point.close)).toEqual([1.1476, 1.149]);
    // Intraday bars never start in the future; an older quote stays out.
    expect(appendLiveQuotePoint(history, quote, { now, mode: "ohlc", resolution: "1h" })).toBe(history);
    expect(appendLiveQuotePoint(history, quote, { now: Date.parse("2026-09-18T00:30:00Z"), mode: "ohlc", resolution: "1d" }))
      .toBe(history);
  });

  test("extends coarse chart histories with a fresh quote tail", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-04T00:00:00Z"), close: 56 },
      { date: new Date("2026-05-11T00:00:00Z"), close: 68 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture(),
      { now: Date.parse("2026-05-15T19:45:00Z") },
    );

    expect(extended).toHaveLength(3);
    expect(extended.at(-1)).toEqual({
      date: new Date("2026-05-15T19:30:00Z"),
      close: 129,
    });
  });

  test("merges a quote into the active OHLC bucket", () => {
    const history: PricePoint[] = [
      {
        date: new Date("2026-05-15T19:25:00Z"),
        open: 124,
        high: 130,
        low: 122,
        close: 126,
        volume: 1_000,
      },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-05-15T19:29:00Z") }),
      {
        now: Date.parse("2026-05-15T19:30:00Z"),
        mode: "ohlc",
        resolution: "5m",
      },
    );

    expect(extended).toHaveLength(1);
    expect(extended[0]).toEqual({
      date: new Date("2026-05-15T19:25:00Z"),
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
        date: new Date("2026-05-15T19:25:00Z"),
        open: 124,
        high: 180,
        low: 80,
        close: 126,
        volume: 1_000,
      },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-05-15T19:30:00Z") }),
      {
        now: Date.parse("2026-05-15T19:31:00Z"),
        mode: "ohlc",
        resolution: "5m",
      },
    );

    expect(extended).toHaveLength(2);
    expect(extended[1]).toEqual({
      date: new Date("2026-05-15T19:30:00Z"),
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
      { now: Date.parse("2026-07-22T18:53:00Z") },
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
