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

  test("a pre-market print neither moves yesterday's daily bar nor opens today's", () => {
    const now = Date.parse("2026-09-11T12:00:00Z");
    const history = [{ date: new Date("2026-09-10T13:30:00Z"), close: 100 }];
    const preMarket = quoteFixture({ price: 100, preMarketPrice: 105, marketState: "PRE", lastUpdated: now });
    expect(appendLiveQuotePoint(history, preMarket, { now, mode: "ohlc", resolution: "1d" })).toBe(history);
    // Nor does the last session's close the quote carries: that bar is the history's.
    const withClose = { ...preMarket, regularClose: 101, regularCloseSessionDate: "2026-09-10", regularChange: 1,
      changeSessionDate: "2026-09-11" };
    expect(appendLiveQuotePoint(history, withClose, { now, mode: "ohlc", resolution: "1d" })).toBe(history);
  });

  test("keeps an after-hours quote in its exchange session across UTC midnight, at the regular close", () => {
    const now = Date.parse("2026-09-11T00:01:00Z");
    const updated = appendLiveQuotePoint([{ date: new Date("2026-09-10T00:00:00Z"), close: 100 }],
      quoteFixture({ price: 101, postMarketPrice: 105, marketState: "POST", lastUpdated: now - 60_000 }),
      { now, mode: "ohlc", resolution: "1d" });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.close).toBe(101);
  });

  test("a closed market's daily bar is its regular close, while intraday points keep the after-hours print", () => {
    // CRWV after Thursday's after-hours session: closed at 69.69, last printed 68.10 after hours.
    const now = Date.parse("2026-10-16T03:45:00Z");
    const closed = quoteFixture({
      symbol: "CRWV", price: 68.1, previousClose: 65.78, marketState: "POSTPOST", changeSessionDate: "2026-10-15",
      regularClose: 69.69, regularCloseSessionDate: "2026-10-15", regularChange: 3.91, regularChangePercent: 5.944,
      lastUpdated: Date.parse("2026-10-15T23:59:59Z"),
    });
    const daily: PricePoint[] = [
      { date: new Date("2026-10-14T00:00:00Z"), open: 71.74, high: 72.52, low: 64.41, close: 65.78 },
      { date: new Date("2026-10-15T00:00:00Z"), open: 61.43, high: 69.76, low: 59.51, close: 69.69 },
    ];
    for (const resolution of ["1d", "1wk"] as const) {
      expect(appendLiveQuotePoint(daily, closed, { now, mode: "ohlc", resolution }).at(-1)).toMatchObject({ close: 69.69, low: 59.51 });
    }
    expect(appendLiveQuotePoint(daily.map(({ date, close }) => ({ date, close })), closed, { now }).at(-1)?.close).toBe(69.69);
    const intraday: PricePoint[] = [
      { date: new Date("2026-10-15T23:57:00Z"), close: 68.2 },
      { date: new Date("2026-10-15T23:58:00Z"), close: 68.15 },
    ];
    expect(appendLiveQuotePoint(intraday, closed, { now: Date.parse("2026-10-16T00:00:30Z") }).at(-1)?.close).toBe(68.1);
    // While the session trades, the daily bar follows the live price.
    const open = { ...closed, price: 68.5, marketState: "REGULAR" as const, lastUpdated: Date.parse("2026-10-15T19:30:00Z") };
    expect(appendLiveQuotePoint(daily, open, { now: Date.parse("2026-10-15T19:31:00Z"), mode: "ohlc", resolution: "1d" }).at(-1)?.close).toBe(68.5);
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
