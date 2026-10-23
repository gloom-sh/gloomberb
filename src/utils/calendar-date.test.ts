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

test("a date option takes ISO, year-first, marked, day-first dotted and month-named dates, and never a day and month slashed", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const fails = (value: string) => { try { isoDateOption(value, "from", now); return null; } catch (error) { return (error as Error).message; } };
  expect(isoDateOption(" 2026-10-14 ", "from", now)).toBe("2026-10-14");
  expect(isoDateOption("", "from", now)).toBe("");
  // Dots are written day first; a month is named on either side of the day, in full or in three letters, in any case.
  for (const value of ["1.10.2026", "01.10.2026", "Oct 1 2026", "Oct 1, 2026", "oct. 1st 2026", "October 1, 2026", "1 Oct 2026", "1 October 2026", "1st october, 2026", "Sept 1 2026"]) {
    expect(isoDateOption(value, "from", now)).toBe(value.startsWith("Sept") ? "2026-09-01" : "2026-10-01");
  }
  expect(isoDateOption("03.04.2026", "from", now)).toBe("2026-04-03");
  // The year first is never written day before month, whatever separates them, and Japanese, Chinese and Korean mark each part.
  for (const value of ["2026/10/14", "2026.10.14", "2026-10-14", "2026年10月14日", "2026 年 10 月 14 日", "2026년 10월 14일"]) {
    expect(isoDateOption(value, "from", now)).toBe("2026-10-14");
  }
  expect(isoDateOption("2026/1/4", "from", now)).toBe("2026-01-04");
  // A slash after the day or the month is written both ways round, so it only gets the date to type when one part is plainly the day.
  expect(fails("14/10/2026")).toBe("Use a --from date as YYYY-MM-DD, DD.MM.YYYY, Oct 14 2026 or 14 October 2026: type --from 2026-10-14 for 14/10/2026.");
  expect(["10/14/2026", "14-10-2026", "10.14.2026"].map((value) => fails(value)?.match(/--from (\S+) for/)?.[1]))
    .toEqual(["2026-10-14", "2026-10-14", "2026-10-14"]);
  for (const value of ["03/04/2026", "03-04-2026", "foo", "2026-02-30", "2026/02/30", "2026年2月30日", "10月14日", "31.02.2026", "Feb 30 2026", "Octember 1 2026", "Oct 2026", "31/02/2026", "14/14/2026", "14/10/26", "20261014"]) {
    expect(fails(value)).toBe("Use a --from date as YYYY-MM-DD, DD.MM.YYYY, Oct 14 2026 or 14 October 2026, such as --from 2026-10-14.");
  }
});
