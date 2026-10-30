import { expect, test } from "bun:test";
import type { PricePoint } from "../types/financials";
import { quoteOfficialClose, withOfficialCloses } from "./official-close";

// BDRY's hourly bars on Thu 29 and Fri 30 Oct 2026 (bar open, UTC): the 19:30 bar ends on a 19:38 trade, the 20:00
// closing print comes after it, and 20:30 is after-hours.
const bar = (time: string, close: number): PricePoint => ({ date: new Date(time), open: close, high: close + 0.04, low: close - 0.04, close });
const BARS = [
  bar("2026-10-29T18:30:00Z", 12.0), bar("2026-10-29T19:30:00Z", 12.1),
  bar("2026-10-30T18:30:00Z", 12.25), bar("2026-10-30T19:30:00Z", 12.31), bar("2026-10-30T20:30:00Z", 12.4),
];
const AFTER_CLOSE = Date.parse("2026-10-30T22:00:00Z");

test("each closed session's last regular bar ends on its official close; after-hours and missing closes stay as served", () => {
  const closes = new Map([["2026-10-29", 12.08], ["2026-10-30", 12.19]]);
  const { points, pending } = withOfficialCloses(BARS, closes, { venue: "ARCA", now: AFTER_CLOSE });
  expect(points.map((point) => point.close)).toEqual([12.0, 12.08, 12.25, 12.19, 12.4]);
  // The bar's range takes the close: 12.19 is under its 12.27 low.
  expect(points[3]).toMatchObject({ high: BARS[3]!.high, low: 12.19 });
  expect(pending).toBeNull();
  expect(BARS[3]!.close).toBe(12.31);

  // The newest session closed without its print in: its bar stays, and that is said.
  const waiting = withOfficialCloses(BARS, new Map([["2026-10-29", 12.08]]), { venue: "ARCA", now: AFTER_CLOSE });
  expect(waiting.points[3]!.close).toBe(12.31);
  expect(waiting.pending).toBe("2026-10-30");

  // While the session trades, nothing is replaced and nothing is pending.
  const trading = withOfficialCloses(BARS.slice(0, 4), closes, { venue: "ARCA", now: Date.parse("2026-10-30T19:45:00Z") });
  expect(trading.points.map((point) => point.close)).toEqual([12.0, 12.08, 12.25, 12.31]);
  expect(trading.pending).toBeNull();
});

test("a quote gives its official close only once the session it is from has closed", () => {
  const quote = { symbol: "BDRY", price: 12.4, change: 0, changePercent: 0, currency: "USD", listingExchangeName: "ARCA", lastUpdated: AFTER_CLOSE };
  expect(quoteOfficialClose({ ...quote, marketState: "POST", regularClose: 12.19, regularCloseSessionDate: "2026-10-30" }))
    .toEqual({ date: "2026-10-30", close: 12.19 });
  expect(quoteOfficialClose({ ...quote, marketState: "REGULAR", regularClose: 12.19, regularCloseSessionDate: "2026-10-30" })).toBeNull();
});
