import { expect, test } from "bun:test";
import { PUBLISHED_APAC_CLOSURES } from "./published-apac-sessions";
import { PUBLISHED_FUTURES_CLOSURES } from "./published-futures-sessions";
import {
  hasPublishedSessionCalendar,
  isMiddayBreakPrint,
  isRegularSessionTime,
  isTradingWeekday,
  latestRegularSessionClose,
  middayBreakOn,
  regularSessionCloseOn,
} from "./market/freshness";

test("every published closure is a day of its venue's week, in date order", () => {
  for (const [venue, years] of Object.entries({ ...PUBLISHED_APAC_CLOSURES, ...PUBLISHED_FUTURES_CLOSURES })) {
    for (const [year, dates] of Object.entries(years)) {
      expect([...dates].sort(), `${venue} ${year}`).toEqual([...dates]);
      for (const date of dates) {
        const weekday = new Date(`${year}-${date}T00:00:00Z`).getUTCDay();
        expect(isTradingWeekday(venue, weekday), `${venue} ${year}-${date}`).toBe(true);
      }
    }
  }
});

test("Taiwan's sessions reach back past the Lunar New Year closure, and its unpublished year stays unknown", () => {
  // Wednesday 11 Feb 2026 is the last session before Monday 23 Feb.
  const beforeOpen = Date.parse("2026-02-23T00:30:00Z");
  for (const exchange of ["TWSE", "TPEX"]) {
    expect(latestRegularSessionClose(exchange, beforeOpen)?.date).toBe("2026-02-11");
    expect(isRegularSessionTime(exchange, Date.parse("2026-02-13T02:00:00Z"))).toBe(false);
    expect(hasPublishedSessionCalendar(exchange, "2026-02-23")).toBe(true);
    expect(hasPublishedSessionCalendar(exchange, "2027-02-23")).toBe(false);
  }
  expect(hasPublishedSessionCalendar("KOSDAQ", "2027-02-23")).toBe(true);
});

/**
 * A half day ends after the morning: HKEX's Christmas Eve session closed at
 * 12:10 with its auction, and no afternoon session reopened at 13:00, so a
 * header or a stale check reading the afternoon there would read a session
 * that never ran.
 */
test("HKEX, SGX and ASX close their published half days early, with no afternoon session", () => {
  const iso = (time: number | null | undefined) => (time == null ? null : new Date(time).toISOString());
  // Thursday 24 Dec 2026: HKEX to 12:10 and SGX to 12:16 (UTC+8), ASX to 14:10 Sydney (UTC+11).
  expect(iso(regularSessionCloseOn("HKEX", "2026-12-24"))).toBe("2026-12-24T04:10:00.000Z");
  expect(iso(regularSessionCloseOn("SGX", "2026-12-24"))).toBe("2026-12-24T04:20:00.000Z");
  expect(iso(regularSessionCloseOn("ASX", "2026-12-24"))).toBe("2026-12-24T03:15:00.000Z");
  for (const venue of ["HKEX", "SGX"]) {
    expect(middayBreakOn(venue, Date.parse("2026-12-24T04:30:00Z"))).toBeNull();
    expect(isRegularSessionTime(venue, Date.parse("2026-12-24T05:30:00Z"))).toBe(false);
    // The day before is a whole one: the afternoon session after its break.
    expect(middayBreakOn(venue, Date.parse("2026-12-23T04:30:00Z"))).not.toBeNull();
    expect(isRegularSessionTime(venue, Date.parse("2026-12-23T05:30:00Z"))).toBe(true);
  }
  // A print from the half day's close is no midday pause: the session is over.
  expect(isMiddayBreakPrint(Date.parse("2026-12-24T04:09:00Z"), "HKEX", Date.parse("2026-12-24T04:30:00Z"), 0)).toBe(false);
  expect(isMiddayBreakPrint(Date.parse("2026-12-23T03:59:00Z"), "HKEX", Date.parse("2026-12-23T04:30:00Z"), 0)).toBe(true);
  // Lunar New Year's Eve, before three days of closures.
  expect(iso(regularSessionCloseOn("HKEX", "2026-02-16"))).toBe("2026-02-16T04:10:00.000Z");
  expect(latestRegularSessionClose("HKEX", Date.parse("2026-02-20T01:00:00Z"))?.date).toBe("2026-02-16");
});
