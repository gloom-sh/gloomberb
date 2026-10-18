import { expect, test } from "bun:test";
import { barLastSession } from "./bar-period";

test("a complete weekly or monthly bar ends on the last session its venue's calendar has in the period, or the last weekday outside it", () => {
  const later = Date.parse("2029-06-01T00:00:00Z");
  const cases: Array<[string, "week" | "month", string | undefined, string]> = [
    // Labor Day week, dated by its holiday Monday, closed on Friday; the week of 3 Jul 2026, a Friday closure, on Thursday.
    ["2026-09-07", "week", "NASDAQ", "2026-09-11"],
    ["2026-06-29", "week", "NASDAQ", "2026-07-02"],
    // Tokyo closes on 31 Dec, so its December ends on Wednesday the 30th; Silver Week leaves its week Thursday and Friday.
    ["2026-12-01", "month", "JPX", "2026-12-30"],
    ["2026-09-21", "week", "JPX", "2026-09-25"],
    // Outside the published calendars (NASDAQ's from 2025, JPX's 2026 and 2027) a month ends on its last weekday,
    // 31 Dec, though Tokyo was closed that day in 2025.
    ["2024-12-01", "month", "NASDAQ", "2024-12-31"],
    ["2025-12-01", "month", "JPX", "2025-12-31"],
    // A venue whose sessions are unknown is read by the calendar; a coin's period ends on its last day.
    ["2026-05-01", "month", undefined, "2026-05-29"],
    ["2026-10-12", "week", "CCC", "2026-10-18"],
  ];
  for (const [date, period, venue, last] of cases) {
    expect([date, period, venue, barLastSession(date, period, venue, later)]).toEqual([date, period, venue, last]);
  }
});

test("a bar whose period runs on is dated by how far it runs, never past today", () => {
  // Wed 16 Dec 2026 07:00 UTC: Tokyo's session has closed, so its December runs through today.
  expect(barLastSession("2026-12-01", "month", "JPX", Date.parse("2026-12-16T07:00:00Z"))).toBe("2026-12-16");
  // Sat 17 Oct 2026: New York's week of Mon 12 Oct closed on Friday; with its sessions unknown, the week runs to
  // Sunday and names no day, so a caller keeps the bar's own date.
  expect(barLastSession("2026-10-12", "week", "NASDAQ", Date.parse("2026-10-17T12:00:00Z"))).toBe("2026-10-16");
  expect(barLastSession("2026-10-12", "week", undefined, Date.parse("2026-10-17T12:00:00Z"))).toBeNull();
  expect(barLastSession("not a date", "week", "NASDAQ", Date.parse("2026-10-17T12:00:00Z"))).toBeNull();
});
