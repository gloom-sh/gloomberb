import { expect, test } from "bun:test";
import { globexDayOpen, globexPrintSession } from "./globex-day";

const at = (iso: string) => Date.parse(iso);

test("Globex opens Sunday at 17:00 Central and shuts for the hour from 16:00, on Central time across the week clocks fall back", () => {
  // Fri 30 Oct 2026 closes at 16:00 CDT (21:00 UTC); Sunday 1 Nov is the first day of CST, so it reopens at 17:00 CST (23:00 UTC).
  expect(globexDayOpen("CME", at("2026-10-30T20:59:00Z"))).toBe(true);
  expect(globexDayOpen("CME", at("2026-10-30T21:00:00Z"))).toBe(false);
  expect(globexDayOpen("CME", at("2026-10-31T15:00:00Z"))).toBe(false);
  expect(globexDayOpen("CME", at("2026-11-01T22:00:00Z"))).toBe(false);
  expect(globexDayOpen("CME", at("2026-11-01T22:59:00Z"))).toBe(false);
  expect(globexDayOpen("CME", at("2026-11-01T23:00:00Z"))).toBe(true);
  // The daily break: 16:00 to 17:00 Central, an hour later in UTC than the week before.
  expect(globexDayOpen("NYM", at("2026-10-28T21:30:00Z"))).toBe(false);
  expect(globexDayOpen("NYM", at("2026-10-28T22:30:00Z"))).toBe(true);
  expect(globexDayOpen("NYM", at("2026-11-04T21:30:00Z"))).toBe(true);
  expect(globexDayOpen("NYM", at("2026-11-04T22:30:00Z"))).toBe(false);
  expect(globexDayOpen("CMX", at("2026-11-04T23:00:00Z"))).toBe(true);
  // Thanksgiving's hours vary by contract, and another venue keeps its own: neither is the clock's to say.
  expect(globexDayOpen("CME", at("2026-11-26T15:00:00Z"))).toBeNull();
  expect(globexDayOpen("ICE FUTURES", at("2026-11-04T15:00:00Z"))).toBeNull();
});

test("a print from the 17:00 reopen to the 08:30 day open is the next trade date's overnight, a Sunday evening's Monday's", () => {
  // Wed 4 Nov 2026, 17:18 CST: Thursday's trade date, overnight until 08:30 CST Thursday (14:30 UTC).
  expect(globexPrintSession("CME", at("2026-11-04T23:18:00Z"))).toEqual({ tradeDate: "2026-11-05", overnight: true });
  expect(globexPrintSession("CME", at("2026-11-05T14:29:00Z"))).toEqual({ tradeDate: "2026-11-05", overnight: true });
  expect(globexPrintSession("CME", at("2026-11-05T14:30:00Z"))).toEqual({ tradeDate: "2026-11-05", overnight: false });
  // The last print before the break is the day's own.
  expect(globexPrintSession("CME", at("2026-11-04T21:59:00Z"))).toEqual({ tradeDate: "2026-11-04", overnight: false });
  expect(globexPrintSession("CME", at("2026-11-01T23:05:00Z"))).toEqual({ tradeDate: "2026-11-02", overnight: true });
  expect(globexPrintSession("ICE FUTURES", at("2026-11-04T23:18:00Z"))).toBeNull();
  expect(globexPrintSession("CME", 0)).toBeNull();
});
