import { expect, test } from "bun:test";
import {
  hasPublishedSessionCalendar,
  isRegularSessionTime,
  latestRegularSessionClose,
  latestRegularSessionOpen,
} from "./market/freshness";

test("Chinese sessions reach past Spring Festival before reopening, including listing aliases", () => {
  const beforeOpen = Date.parse("2026-02-24T01:00:00Z");
  for (const exchange of ["SSE", "XSHG", "SHH", "SZSE", "XSHE", "SHE"]) {
    expect(hasPublishedSessionCalendar(exchange, "2026-02-24")).toBe(true);
    expect(latestRegularSessionClose(exchange, beforeOpen)?.date).toBe("2026-02-13");
    expect(latestRegularSessionOpen(exchange, beforeOpen)).toBe(Date.parse("2026-02-13T01:30:00Z"));
    expect(isRegularSessionTime(exchange, beforeOpen)).toBe(false);
    expect(isRegularSessionTime(exchange, Date.parse("2026-02-24T02:00:00Z"))).toBe(true);
    expect(hasPublishedSessionCalendar(exchange, "2027-02-24")).toBe(false);
  }
});

test("Chinese make-up working weekends remain closed exchange sessions", () => {
  const saturday = Date.parse("2026-10-10T02:00:00Z");
  for (const exchange of ["SSE", "SZSE"]) {
    expect(latestRegularSessionClose(exchange, saturday)?.date).toBe("2026-10-09");
    expect(latestRegularSessionOpen(exchange, saturday)).toBe(Date.parse("2026-10-09T01:30:00Z"));
    expect(isRegularSessionTime(exchange, saturday)).toBe(false);
  }
});
