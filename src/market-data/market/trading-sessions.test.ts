import { expect, test } from "bun:test";
import { latestTradingSessionOpen } from "./trading-sessions";

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
