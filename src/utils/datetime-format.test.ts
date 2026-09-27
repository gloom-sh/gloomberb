import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { formatRelativeAge, formatRelativeTime, formatShortDate, formatTimeAgo } from "./datetime-format";

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
    expect(formatTimeAgo(new Date(weekAgo))).toMatch(/^9\/1[67]\/26$/);
    expect(formatTimeAgo(new Date(weekAgo), { short: true })).toMatch(/^9\/1[67]\/26$/);

    expect(formatRelativeAge(undefined, now)).toBe("never");
    expect(formatRelativeTime("not a date", now)).toBe("-");
    expect(formatTimeAgo("not a date")).toBe("unknown");
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
  expect(formatShortDate("2026-01-05", { utc: true })).toBe("Jan 5, 2026");
  expect(formatShortDate("2026-01-05", { year: false, utc: true })).toBe("Jan 5");
  expect(formatShortDate("2026-01-05", { day: "2-digit", year: "2-digit", utc: true })).toBe("Jan 05, 26");
  expect(formatShortDate(lateOnNewYearsEve, { utc: true })).toBe("Dec 31, 2025");
  expect(formatShortDate(null, { fallback: "--" })).toBe("--");
  expect(formatShortDate("not a date")).toBe("-");
});
