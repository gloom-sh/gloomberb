import { expect, test } from "bun:test";
import { PUBLISHED_APAC_CLOSURES } from "./published-apac-sessions";
import { hasPublishedSessionCalendar, isRegularSessionTime, latestRegularSessionClose } from "./market/freshness";

test("every published closure is a weekday, in date order", () => {
  for (const [venue, years] of Object.entries(PUBLISHED_APAC_CLOSURES)) {
    for (const [year, dates] of Object.entries(years)) {
      expect([...dates].sort(), `${venue} ${year}`).toEqual([...dates]);
      for (const date of dates) {
        const weekday = new Date(`${year}-${date}T00:00:00Z`).getUTCDay();
        expect(weekday >= 1 && weekday <= 5, `${venue} ${year}-${date}`).toBe(true);
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
