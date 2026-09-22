import { expect, test } from "bun:test";
import { calendarMonthsBefore } from "./calendar-date";

test("calendar horizons clamp missing dates without making month end sticky or losing the UTC clock", () => {
  const cases: Array<[string, number, string]> = [
    ["2026-03-29", 1, "2026-02-28"], ["2026-03-30", 1, "2026-02-28"], ["2026-03-31", 1, "2026-02-28"],
    ["2024-03-31", 1, "2024-02-29"], ["2026-05-31", 3, "2026-02-28"], ["2026-08-31", 6, "2026-02-28"],
    ["2024-02-29", 12, "2023-02-28"], ["2024-02-29", 36, "2021-02-28"], ["2024-02-29", 60, "2019-02-28"],
    ["2026-01-31", 1, "2025-12-31"], ["2026-04-30", 1, "2026-03-30"], ["2026-02-28", 1, "2026-01-28"],
    // Subtract from the original date once; repeated one-month steps lose days.
    ["2026-05-31", 6, "2025-11-30"], ["2024-03-31", 12, "2023-03-31"],
  ];
  for (const [end, months, expected] of cases) {
    const original = new Date(`${end}T15:45:12.345Z`);
    expect(calendarMonthsBefore(original, months).toISOString()).toBe(`${expected}T15:45:12.345Z`);
    expect(original.toISOString()).toBe(`${end}T15:45:12.345Z`);
  }
});
