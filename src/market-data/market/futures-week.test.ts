import { describe, expect, test } from "bun:test";
import { futuresWeekendClosure } from "./futures-week";

const utc = (iso: string) => Date.parse(iso);
const iso = (time: number | undefined) => (time == null ? undefined : new Date(time).toISOString());

describe("futuresWeekendClosure", () => {
  test("runs from the Friday 16:00 Central close to the Sunday 17:00 Central open", () => {
    // Fri 23 Oct 2026: Chicago is on daylight time (UTC-5), so the close is 21:00 UTC and the open 22:00 UTC two days on.
    expect(futuresWeekendClosure("NYM", utc("2026-10-23T20:59:00Z"))).toBeNull();
    const closed = futuresWeekendClosure("NYM", utc("2026-10-23T21:00:00Z"));
    expect(iso(closed?.closedAt)).toBe("2026-10-23T21:00:00.000Z");
    expect(iso(closed?.reopensAt)).toBe("2026-10-25T22:00:00.000Z");
    expect(closed?.reopensOn).toBe("2026-10-25");
    // Saturday, and Sunday until the minute before the open.
    expect(futuresWeekendClosure("NYM", utc("2026-10-24T12:00:00Z"))).toMatchObject({ reopensOn: "2026-10-25" });
    expect(futuresWeekendClosure("NYM", utc("2026-10-25T05:35:00Z"))).not.toBeNull();
    expect(futuresWeekendClosure("NYM", utc("2026-10-25T21:59:00Z"))).not.toBeNull();
    // The open ends it: nothing is claimed of the week that follows.
    expect(futuresWeekendClosure("NYM", utc("2026-10-25T22:00:00Z"))).toBeNull();
    expect(futuresWeekendClosure("NYM", utc("2026-10-26T14:00:00Z"))).toBeNull();
    expect(futuresWeekendClosure("NYM", utc("2026-10-29T14:00:00Z"))).toBeNull();
  });

  test("follows Chicago's clock across the change to standard time", () => {
    // Sun 1 Nov 2026 02:00 Central falls back: the Friday close is still 21:00 UTC, the Sunday open 23:00 UTC.
    expect(iso(futuresWeekendClosure("CME", utc("2026-10-31T12:00:00Z"))?.closedAt)).toBe("2026-10-30T21:00:00.000Z");
    expect(iso(futuresWeekendClosure("CME", utc("2026-10-31T12:00:00Z"))?.reopensAt)).toBe("2026-11-01T23:00:00.000Z");
    expect(futuresWeekendClosure("CME", utc("2026-11-01T22:30:00Z"))).not.toBeNull();
    expect(futuresWeekendClosure("CME", utc("2026-11-01T23:00:00Z"))).toBeNull();
  });

  test("covers every venue a futures board lists under any name its quotes give, and no other", () => {
    const sunday = utc("2026-10-25T05:35:00Z");
    for (const venue of ["CME", "CBT", "CBOT", "NYM", "NYMEX", "NY MERCANTILE", "CMX", "COMEX"]) {
      expect(futuresWeekendClosure(venue, sunday)?.reopensOn).toBe("2026-10-25");
    }
    // ICE U.S. contracts open by contract, from Sunday evening (cotton) to Monday morning (coffee): closed, no open to name.
    expect(futuresWeekendClosure("ICE FUTURES", sunday)).toEqual({ closedAt: utc("2026-10-23T21:00:00Z") });
    for (const venue of ["NYSE", "CCC", "CCY", "ASX", "", undefined]) expect(futuresWeekendClosure(venue, sunday)).toBeNull();
  });
});
