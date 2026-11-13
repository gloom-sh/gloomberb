import { MISSING_VALUE } from "./format";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { formatFilingDate, formatWeekdayDay, formatDetailDate, formatDetailTime, formatFeedTime, formatRelativeAge, formatRelativeTime, formatShortDate, formatTimeAgo, localTimeZoneShortName } from "./datetime-format";
import { timeZoneLabel } from "./zoned-date-time";

afterEach(() => setSystemTime());

describe("relative time", () => {
  // formatRelativeAge and formatTimeAgo are public plugin API; they share one
  // ladder, so a change for one style must not move the other's text.
  test("every style reads the same minute, hour and day boundaries", () => {
    const now = Date.UTC(2026, 8, 23, 12);
    setSystemTime(now);
    const cases: Array<[ageMs: number, age: string, short: string]> = [
      [-60_000, "just now", "<1m"],
      [59_999, "just now", "<1m"],
      [60_000, "1m ago", "1m"],
      [3_599_999, "59m ago", "59m"],
      [3_600_000, "1h ago", "1h"],
      [86_399_999, "23h ago", "23h"],
      [6 * 86_400_000, "6d ago", "6d"],
    ];
    for (const [ageMs, age, short] of cases) {
      const iso = new Date(now - ageMs).toISOString();
      expect(formatRelativeAge(now - ageMs, now)).toBe(age);
      expect(formatTimeAgo(iso)).toBe(age);
      expect(formatTimeAgo(iso, { short: true })).toBe(short);
      expect(formatRelativeTime(iso, now)).toBe(short);
    }

    // Only the feed style turns into a (local) date after a week.
    const weekAgo = now - 7 * 86_400_000;
    expect(formatRelativeAge(weekAgo, now)).toBe("7d ago");
    expect(formatRelativeTime(weekAgo, now)).toBe("7d");
    expect(formatTimeAgo(new Date(weekAgo))).toMatch(/^1[67] Sep$/);
    expect(formatTimeAgo(new Date(weekAgo), { short: true })).toMatch(/^1[67] Sep$/);

    expect(formatRelativeAge(undefined, now)).toBe("never");
    expect(formatRelativeTime("not a date", now)).toBe(MISSING_VALUE);
    expect(formatTimeAgo("not a date")).toBe("unknown");
  });

  test("a date past the week is the local calendar day, day first, with the year when it is another one", () => {
    setSystemTime(new Date("2027-01-10T12:00:00Z"));
    for (const value of ["2024-02-29T23:59:59Z", "2025-12-31T23:30:00Z", "2026-01-01T00:00:00Z", "2026-10-25T01:30:00Z"]) {
      const date = new Date(value);
      const month = date.toLocaleDateString("en-US", { month: "short" });
      const local = `${date.getDate()} ${month} '${String(date.getFullYear()).slice(-2)}`;
      expect(formatTimeAgo(value)).toBe(local);
      expect(formatTimeAgo(date, { short: true })).toBe(local);
    }
  });

  test("handles UTC ISO timestamps with explicit offsets", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString().replace("Z", "+00:00");
    expect(formatTimeAgo(fiveMinutesAgo)).toBe("5m ago");
  });

  test("treats space-separated chat timestamps without a timezone as UTC", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString().replace("T", " ").replace("Z", "");
    expect(formatTimeAgo(fiveMinutesAgo)).toBe("5m ago");
  });
});

test("short dates keep each style's formatter apart", () => {
  const lateOnNewYearsEve = "2025-12-31T23:30:00Z";
  expect(formatShortDate("2026-01-05", { utc: true })).toBe("5 Jan 2026");
  expect(formatShortDate("2026-01-05", { year: false, utc: true })).toBe("5 Jan");
  expect(formatShortDate("2026-01-05", { day: "2-digit", year: "2-digit", utc: true })).toBe("05 Jan '26");
  expect(formatShortDate(lateOnNewYearsEve, { utc: true })).toBe("31 Dec 2025");
  expect(formatShortDate(null, { fallback: "--" })).toBe("--");
  expect(formatShortDate("not a date")).toBe(MISSING_VALUE);
});

test("feed times read as a clock today, a weekday this week and a date before", () => {
  // Local wall-clock times, so the case holds in every time zone.
  const now = new Date(2026, 8, 29, 20, 45).getTime();
  const cases: Array<[Date, string]> = [
    [new Date(2026, 8, 29, 14, 32), "14:32"],
    [new Date(2026, 8, 29, 0, 5), "00:05"],
    [new Date(2026, 8, 28, 23, 59), "Mon 23:59"],
    // Six days back is the last day a weekday names; a week back is a date.
    [new Date(2026, 8, 23, 9, 10), "Wed 09:10"],
    [new Date(2026, 8, 22, 9, 10), "22 Sep"],
    [new Date(2025, 8, 18, 8, 0), "18 Sep '25"],
    // A clock ahead of ours never reads as a weekday or a time.
    [new Date(2026, 8, 30, 1, 0), "30 Sep"],
  ];
  for (const [date, label] of cases) expect(formatFeedTime(date, now)).toBe(label);
  expect(formatFeedTime("not a date", now)).toBe(MISSING_VALUE);
});

test("a detail date names its zone, so a story read beside a list in UTC is not two hours off", () => {
  expect(formatDetailDate("2026-10-07T21:38:00Z", "-", "UTC")).toBe("7 Oct 2026, 21:38 UTC");
  expect(formatDetailDate("2026-10-07T21:38:00Z", "-", "Europe/Berlin")).toBe("7 Oct 2026, 23:38 CEST");
  expect(formatDetailDate("2026-10-07T21:38:00Z", "-", "America/New_York")).toBe("7 Oct 2026, 17:38 ET");
  // A same-day coverage time, beside the story's dated header, names its zone too.
  expect(formatDetailTime("2026-10-07T21:38:00Z", "-", "Europe/Berlin")).toBe("23:38 CEST");
});

test("a zone reads the name it has on that day, the same in a time column as on a chart", () => {
  // Europe names its summer time apart; New York's "ET" holds all year.
  expect(formatDetailTime("2026-01-07T12:00:00Z", "-", "Europe/Paris")).toBe("13:00 CET");
  expect(formatDetailTime("2026-07-07T12:00:00Z", "-", "Europe/Paris")).toBe("14:00 CEST");
  expect(formatDetailTime("2026-01-07T12:00:00Z", "-", "Europe/London")).toBe("12:00 GMT");
  expect(formatDetailTime("2026-07-07T12:00:00Z", "-", "Europe/London")).toBe("13:00 BST");
  expect(formatDetailTime("2026-07-07T12:00:00Z", "-", "America/New_York")).toBe("08:00 ET");
  // The day the clocks go back: 00:30 UTC is still summer time in Paris, 01:30 UTC is not.
  expect(localTimeZoneShortName("2026-10-25T00:30:00Z", "Europe/Paris")).toBe("CEST");
  expect(localTimeZoneShortName("2026-10-25T01:30:00Z", "Europe/Paris")).toBe("CET");
  // A zone without a short name reads its city, as the chart's axis names it, not "GMT+8".
  expect(localTimeZoneShortName("2026-07-07T12:00:00Z", "Asia/Shanghai")).toBe(timeZoneLabel("Asia/Shanghai"));
  expect(localTimeZoneShortName("2026-07-07T12:00:00Z", "Asia/Shanghai")).toBe("Shanghai");
});

test("calendar dates consistently read day-first", () => {
  const day = new Date(2026, 0, 5, 12);
  expect(formatShortDate(day)).toBe("5 Jan 2026");
  expect(formatShortDate(day, { day: "2-digit" })).toBe("05 Jan 2026");
  expect(formatShortDate(day, { year: false })).toBe("5 Jan");
  expect(formatFilingDate("2026-11-04")).toBe("04 Nov 2026");
  expect(formatDetailDate("2026-10-07T22:38:00Z", "-", "Europe/Berlin")).toBe("8 Oct 2026, 00:38 CEST");
  expect(formatWeekdayDay("2026-10-16T00:00:00Z", { timeZone: "UTC" })).toBe("Fri 16 Oct");
  expect(formatWeekdayDay("2027-10-16T00:00:00Z", { timeZone: "UTC", year: true })).toBe("Sat 16 Oct 2027");
});
