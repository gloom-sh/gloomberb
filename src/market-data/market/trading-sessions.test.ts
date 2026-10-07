import { describe, expect, test } from "bun:test";
import { latestSessionStart, latestTradingSessionOpen, priorSessionClose } from "./trading-sessions";

const open = (symbol: string, exchange: string, iso: string) => {
  const value = latestTradingSessionOpen(symbol, exchange, Date.parse(iso));
  return value === null ? null : new Date(value).toISOString();
};

test("CME Globex days open at 17:00 Central the evening before, Sunday for Monday", () => {
  // Monday 10:00 Central belongs to the session that opened Sunday evening.
  expect(open("ES=F", "CME", "2026-09-28T15:00:00Z")).toBe("2026-09-27T22:00:00.000Z");
  expect(open("ES=F", "CME", "2026-09-28T22:30:00Z")).toBe("2026-09-28T22:00:00.000Z");
  // Friday's session opened Thursday evening; the weekend opens nothing.
  expect(open("CLZ26.NYM", "", "2026-10-03T12:00:00Z")).toBe("2026-10-01T22:00:00.000Z");
  // Grains reopen at 19:00, inside the same trading day.
  expect(open("ZC=F", "CBT", "2026-09-29T00:30:00Z")).toBe("2026-09-28T22:00:00.000Z");
  // Standard time moves the open an hour later in UTC.
  expect(open("GC=F", "COMEX", "2026-12-01T15:00:00Z")).toBe("2026-11-30T23:00:00.000Z");
});

test("ICE U.S. contracts open at their published New York times", () => {
  expect(open("KC=F", "NYB", "2026-09-29T15:00:00Z")).toBe("2026-09-29T08:15:00.000Z");
  expect(open("SBH27.NYB", "", "2026-09-29T15:00:00Z")).toBe("2026-09-29T07:30:00.000Z");
  // Cotton opens at 21:00 the evening before; the dollar index at 20:00, 18:00 on Sundays.
  expect(open("CT=F", "ICE FUTURES", "2026-09-29T15:00:00Z")).toBe("2026-09-29T01:00:00.000Z");
  expect(open("DX-Y.NYB", "NYB", "2026-09-29T15:00:00Z")).toBe("2026-09-29T00:00:00.000Z");
  expect(open("DX-Y.NYB", "NYB", "2026-09-28T15:00:00Z")).toBe("2026-09-27T22:00:00.000Z");
});

test("stocks keep their regular open, now known for venues that only had a close", () => {
  expect(open("NVDA", "NASDAQ", "2026-09-29T15:00:00Z")).toBe("2026-09-29T13:30:00.000Z");
  // 10:00 Sydney.
  expect(open("BHP", "ASX", "2026-09-29T02:00:00Z")).toBe("2026-09-29T00:00:00.000Z");
  expect(open("BTC-USD", "CCC", "2026-09-29T02:00:00Z")).toBeNull();
});

describe("a one-day chart's session", () => {
  const start = (symbol: string, exchange: string, latest: string, extendedHours = false) => {
    const value = latestSessionStart(symbol, exchange, Date.parse(latest), { extendedHours });
    return value === null ? null : new Date(value).toISOString();
  };

  test("is the latest session of the venue, also when the market is closed", () => {
    expect(start("AAPL", "NASDAQ", "2026-10-02T18:30:00Z")).toBe("2026-10-02T13:30:00.000Z");
    // Over the weekend the last bar is Friday's, so the chart shows Friday.
    expect(start("AAPL", "NASDAQ", "2026-10-02T19:59:00Z")).toBe("2026-10-02T13:30:00.000Z");
    // On Thanksgiving the last bar is Wednesday's, so the chart shows Wednesday.
    expect(start("AAPL", "NASDAQ", "2026-11-25T20:59:00Z")).toBe("2026-11-25T14:30:00.000Z");
    expect(start("7203.T", "JPX", "2026-10-02T06:24:00Z")).toBe("2026-10-02T00:00:00.000Z");
    // CME's day opened at 17:00 Central the evening before, across the change to standard time.
    expect(start("ES=F", "CME", "2026-10-02T18:35:00Z")).toBe("2026-10-01T22:00:00.000Z");
    expect(start("ES=F", "CME", "2026-11-02T15:00:00Z")).toBe("2026-11-01T23:00:00.000Z");
  });

  test("keeps a rolling day for round-the-clock markets and venues without known hours", () => {
    expect(start("BTC-USD", "CCC", "2026-10-02T18:30:00Z")).toBeNull();
    expect(start("EURUSD=X", "CCY", "2026-10-02T18:30:00Z")).toBeNull();
    expect(start("TEVA", "TASE", "2026-10-01T12:00:00Z")).toBeNull();
  });

  test("starts at 04:00 New York with extended hours, a pre-market bar opening the new day", () => {
    expect(start("AAPL", "NASDAQ", "2026-10-02T23:59:00Z", true)).toBe("2026-10-02T08:00:00.000Z");
    expect(start("AAPL", "NASDAQ", "2026-10-05T11:00:00Z", true)).toBe("2026-10-05T08:00:00.000Z");
    expect(start("AAPL", "NASDAQ", "2026-12-01T12:00:00Z", true)).toBe("2026-12-01T09:00:00.000Z");
    // Other venues have no extended session to show.
    expect(start("7203.T", "JPX", "2026-10-02T06:24:00Z", true)).toBe("2026-10-02T00:00:00.000Z");
  });

  test("measures from the previous session's last regular bar, past its after-hours", () => {
    const bars = [
      { time: Date.parse("2026-10-01T19:59:00Z"), close: 330.31 },
      { time: Date.parse("2026-10-01T23:59:00Z"), close: 330.9 },
      { time: Date.parse("2026-10-02T08:00:00Z"), close: 331.2 },
      { time: Date.parse("2026-10-02T13:30:00Z"), close: 332 },
    ];
    expect(priorSessionClose(bars, Date.parse("2026-10-02T08:00:00Z"), "AAPL", "NASDAQ")).toBe(330.31);
    // Futures take the last bar before their open, whatever its hour.
    expect(priorSessionClose(bars, Date.parse("2026-10-01T22:00:00Z"), "ES=F", "CME")).toBe(330.31);
    expect(priorSessionClose(bars, Date.parse("2026-10-01T12:00:00Z"), "AAPL", "NASDAQ")).toBeNull();
  });
});
