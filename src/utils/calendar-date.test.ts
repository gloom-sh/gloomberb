import { expect, test } from "bun:test";
import { calendarMonthsBefore, isoDateOption } from "./calendar-date";

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

test("a date option takes YYYY-MM-DD and shows a date written another way as the option to type", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const fails = (value: string) => { try { isoDateOption(value, "from", now); return null; } catch (error) { return (error as Error).message; } };
  expect(isoDateOption(" 2026-10-14 ", "from", now)).toBe("2026-10-14");
  expect(isoDateOption("", "from", now)).toBe("");
  expect(fails("14/10/2026")).toBe("Use a --from date in YYYY-MM-DD format: type --from 2026-10-14 for 14/10/2026.");
  // A part over 12 is the day, whichever side it is on, and any of the usual separators reads.
  expect(["14.10.2026", "14-10-2026", "10/14/2026", "2026/10/14", "2026.10.14", "2026-10-4"].map((value) => fails(value)?.match(/--from (\S+) for/)?.[1]))
    .toEqual(["2026-10-14", "2026-10-14", "2026-10-14", "2026-10-14", "2026-10-14", "2026-10-04"]);
  // Dots are written day first; a slash or a dash is written both ways round, so it only names the format.
  expect(fails("03.04.2026")).toBe("Use a --from date in YYYY-MM-DD format: type --from 2026-04-03 for 03.04.2026 (day first).");
  expect(fails("03/04/2026")).toBe("Use a --from date in YYYY-MM-DD format, such as --from 2026-10-14.");
  expect(fails("03-04-2026")).toBe("Use a --from date in YYYY-MM-DD format, such as --from 2026-10-14.");
  for (const value of ["foo", "2026-02-30", "31/02/2026", "14/14/2026", "14/10/26", "20261014"]) {
    expect(fails(value)).toBe("Use a --from date in YYYY-MM-DD format, such as --from 2026-10-14.");
  }
});
