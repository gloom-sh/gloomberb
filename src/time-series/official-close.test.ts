import { expect, test } from "bun:test";
import type { PricePoint, Quote } from "../types/financials";
import { newestClosedSession, newestSessionClose, withOfficialCloses } from "./official-close";

// BDRY's hourly bars on Thu 29 and Fri 30 Oct 2026 (bar open, UTC): the 19:30 bar ends on a 19:38 trade, the 20:00
// closing print comes after it, and 20:30 is after-hours.
const bar = (time: string, close: number): PricePoint => ({ date: new Date(time), open: close, high: close + 0.04, low: close - 0.04, close });
const BARS = [
  bar("2026-10-29T18:30:00Z", 12.0), bar("2026-10-29T19:30:00Z", 12.1),
  bar("2026-10-30T18:30:00Z", 12.25), bar("2026-10-30T19:30:00Z", 12.31), bar("2026-10-30T20:30:00Z", 12.4),
];
const AFTER_CLOSE = Date.parse("2026-10-30T20:10:00Z");
const ARCA = { venue: "ARCA", now: AFTER_CLOSE };

test("each closed session's last regular bar ends on its close; after-hours, a session trading and a close in other units stay as served", () => {
  const points = withOfficialCloses(BARS, new Map([["2026-10-29", 12.08], ["2026-10-30", 12.19]]), ARCA);
  expect(points.map((point) => point.close)).toEqual([12.0, 12.08, 12.25, 12.19, 12.4]);
  // The bar's range takes the close: 12.19 is under its 12.27 low.
  expect(points[3]).toMatchObject({ high: BARS[3]!.high, low: 12.19 });
  expect(BARS[3]!.close).toBe(12.31);
  // While the session trades, its bars are its trades.
  const trading = withOfficialCloses(BARS.slice(0, 4), new Map([["2026-10-30", 12.19]]), { venue: "ARCA", now: Date.parse("2026-10-30T19:45:00Z") });
  expect(trading.map((point) => point.close)).toEqual([12.0, 12.1, 12.25, 12.31]);
  // 1219 is the close in cents: more than 25% off the bar's trade, never taken.
  expect(withOfficialCloses(BARS, new Map([["2026-10-30", 1219]]), ARCA)).toBe(BARS);
  expect(newestClosedSession(BARS, ARCA)).toEqual({ date: "2026-10-30", lastTrade: 12.31 });
  expect(newestClosedSession(BARS.slice(0, 2), ARCA)).toBeNull();
});

test("the newest session ends on the official close, waits for it right after a US close, and otherwise falls back without the note", () => {
  const session = { date: "2026-10-30", lastTrade: 12.31, venue: "ARCA" };
  const quote = (fields: Partial<Quote>): Quote => ({
    symbol: "BDRY", price: 12.33, change: 0, changePercent: 0, currency: "USD", listingExchangeName: "ARCA", lastUpdated: AFTER_CLOSE, ...fields,
  });
  const close = (value: number) => ({ close: value });
  // The auction's print, once the quote has it.
  expect(newestSessionClose(quote({ marketState: "POST", regularClose: 12.19, regularCloseSessionDate: "2026-10-30" }), session)).toEqual(close(12.19));
  // Right after 16:00 without it: the price is the last trade before the auction, so the note stays, daily bar or not.
  expect(newestSessionClose(quote({ marketState: "POST" }), { ...session, dailyClose: 12.31 })).toEqual({ pending: true });
  // A weekend (CLOSED) or the next pre-market without it: the daily bar's close, else the quote's own; never the note.
  const weekend = quote({ marketState: "CLOSED", price: 12.19, lastUpdated: Date.parse("2026-10-30T23:59:00Z") });
  expect(newestSessionClose(weekend, { ...session, dailyClose: 12.2 })).toEqual(close(12.2));
  expect(newestSessionClose(weekend, session)).toEqual(close(12.19));
  expect(newestSessionClose(quote({ marketState: "PRE", price: 12.5, previousClose: 12.19, previousCloseDate: "2026-10-30" }), session)).toEqual(close(12.19));
  // A listing that publishes no closing print is not waited on after its close.
  expect(newestSessionClose(quote({ marketState: "POST", listingExchangeName: "LSE", currency: "GBp", price: 1219 }),
    { date: "2026-10-30", lastTrade: 1225, venue: "LSE" })).toEqual(close(1219));
});

test("a quote's close is taken only from the bars' listing, in their units and near their last trade", () => {
  const session = { date: "2026-10-30", lastTrade: 12.31, venue: "ARCA", currency: "USD" };
  const closed = (fields: Partial<Quote>): Quote => ({
    symbol: "BDRY", price: 12.33, change: 0, changePercent: 0, currency: "USD", listingExchangeName: "ARCA", lastUpdated: AFTER_CLOSE,
    marketState: "POST", regularCloseSessionDate: "2026-10-30", ...fields,
  });
  // Another listing, another currency, 25% off, or the session still trading: the daily bar's close or nothing, no note.
  expect(newestSessionClose(closed({ regularClose: 12.19, listingExchangeName: "LSE" }), session)).toBeNull();
  expect(newestSessionClose(closed({ regularClose: 12.19, currency: "EUR" }), { ...session, dailyClose: 12.2 })).toEqual({ close: 12.2 });
  expect(newestSessionClose(closed({ regularClose: 15.9 }), session)).toBeNull();
  expect(newestSessionClose(closed({ marketState: "REGULAR", regularClose: 12.19 }), session)).toBeNull();
  // A London line in pence against a close in pounds is another unit.
  expect(newestSessionClose(closed({ regularClose: 12.19, currency: "GBp", listingExchangeName: "LSE" }),
    { date: "2026-10-30", lastTrade: 1225, venue: "LSE", currency: "GBp" })).toBeNull();
});
