import { describe, expect, test } from "bun:test";
import type { EarningsCalendarReport } from "../../../api-client/earnings";
import { boardReport, type BoardReport } from "./board-model";
import { moveInWeek } from "./calendar";
import { boardRangeDays, boardRangeWeek, boardRangeWords, calendarDays, calendarWeekDates, calendarWeekLabel, requestedBoardRange } from "./calendar-model";

// Fri Oct 16 2026; the week is Mon Oct 12 to Fri Oct 16.
const TODAY = "2026-10-16";
const report = (symbol: string, fields: Partial<EarningsCalendarReport> = {}, owned = new Map<string, "held" | "watched">()): BoardReport =>
  boardReport({
    symbol, name: `${symbol} Inc.`, date: TODAY, timing: "bmo", timingSource: "filing", reportedAt: null, fiscalPeriod: "2026-09",
    marketCap: 10e9, epsEstimate: null, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
    implied: null, realized: null, averageMove: null, averageReports: 0, ...fields,
  }, owned);

describe("ERN calendar", () => {
  test("a week is Monday to Friday; on a weekend this week is the one about to start", () => {
    expect(calendarWeekDates(TODAY, 0)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(calendarWeekDates("2026-10-18", 0)[0]).toBe("2026-10-19");
    expect(calendarWeekDates("2026-10-17", 0)[0]).toBe("2026-10-19");
    // Across a month end.
    expect(calendarWeekDates(TODAY, 3)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
    expect([-1, 0, 1, 3].map((offset) => calendarWeekLabel(TODAY, offset))).toEqual(["Last week", "This week", "Next week", "Week of Nov 2"]);
  });

  test("one range drives the table's days and the calendar's week: --week as an offset, --date as its day and its week", () => {
    expect([requestedBoardRange(undefined, "last"), requestedBoardRange("", "next"), requestedBoardRange("2026-10-07", undefined), requestedBoardRange(undefined, undefined)])
      .toEqual(["-1", "1", "2026-10-07", ""]);
    expect(boardRangeDays("-1", TODAY).map((day) => day.label)).toEqual(["Mon Oct 5", "Tue Oct 6", "Wed Oct 7", "Thu Oct 8", "Fri Oct 9"]);
    expect(boardRangeDays("0", TODAY).map((day) => day.label).at(-1)).toBe("Today");
    expect(boardRangeDays("2026-10-07", TODAY)).toEqual([{ label: "Wed Oct 7", from: "2026-10-07", to: "2026-10-07" }]);
    // The calendar draws a day's own week, and this week for the days ahead.
    expect([boardRangeWeek("2026-10-07", TODAY), boardRangeWeek("2026-09-25", TODAY), boardRangeWeek("", TODAY), boardRangeWeek("3", TODAY)]).toEqual([-1, -3, 0, 3]);
    expect([boardRangeWords("-1", TODAY), boardRangeWords("2", TODAY), boardRangeWords(TODAY, TODAY), boardRangeWords("2026-10-07", TODAY), boardRangeWords("", TODAY)])
      .toEqual(["last week", "in the week of Oct 26", "today", "on Wed Oct 7", null]);
  });

  test("each day groups its reports before the open, during the session, after the close, then with no time, largest first", () => {
    const week = calendarWeekDates(TODAY, 0);
    const days = calendarDays([
      report("SMALL", { timing: "amc", marketCap: 2e9 }),
      report("BIG", { timing: "amc", marketCap: 900e9 }),
      report("NOCAP", { timing: "amc", marketCap: null }),
      report("UNSET", { timing: null }),
      report("EARLY", { timing: "bmo" }),
      report("NOON", { timing: "dmh" }),
      report("TUE", { date: "2026-10-13" }),
      // Another week's report stays out.
      report("NEXT", { date: "2026-10-19" }),
    ], week, { today: TODAY });

    expect(days.map((day) => [day.weekday, day.label, day.total])).toEqual([
      ["Mon", "Oct 12", 0], ["Tue", "Oct 13", 1], ["Wed", "Oct 14", 0], ["Thu", "Oct 15", 0], ["Fri", "Oct 16", 6],
    ]);
    const friday = days[4]!;
    expect(friday.today).toBe(true);
    expect(friday.groups.map((group) => [group.label, group.reports.map((entry) => entry.symbol)])).toEqual([
      ["Before open", ["EARLY"]],
      ["During market", ["NOON"]],
      // A missing cap sinks, as in the table.
      ["After close", ["BIG", "SMALL", "NOCAP"]],
      ["Time not set", ["UNSET"]],
    ]);
    expect(days[0]!.groups).toEqual([]);
  });

  test("held, then watched names lead each group when mine come first; a full group ends on the count of the rest", () => {
    const owned = new Map<string, "held" | "watched">([["HELD", "held"], ["WATCH", "watched"]]);
    const reports = [
      report("MEGA", { marketCap: 2e12 }, owned),
      report("WATCH", { marketCap: 5e9 }, owned),
      report("HELD", { marketCap: 1e9 }, owned),
      report("MID", { marketCap: 50e9 }, owned),
    ];
    const [friday] = calendarDays(reports, [TODAY], { today: TODAY, mineFirst: true });
    expect(friday!.groups[0]!.reports.map((entry) => entry.symbol)).toEqual(["HELD", "WATCH", "MEGA", "MID"]);

    // Four slots fit them all; three keep the two largest and count the other two in the last slot.
    expect(calendarDays(reports, [TODAY], { today: TODAY, limit: 4 })[0]!.groups[0]).toMatchObject({ more: 0 });
    const full = calendarDays(reports, [TODAY], { today: TODAY, limit: 3 })[0]!.groups[0]!;
    expect(full.reports.map((entry) => entry.symbol)).toEqual(["MEGA", "MID"]);
    expect(full.more).toBe(2);
  });

  test("a market holiday is marked closed", () => {
    // Thanksgiving, Thu Nov 26 2026.
    const days = calendarDays([], calendarWeekDates("2026-11-23", 0), { today: "2026-11-23" });
    expect(days.map((day) => day.closed)).toEqual([false, false, false, true, false]);
  });

  test("the arrows move along a row and on into the next day at the same depth, and up and down a day", () => {
    const [a, b, c, d, e] = ["A", "B", "C", "D", "E"].map((symbol) => report(symbol));
    // Monday has two rows (A B, then C), Tuesday none, Wednesday one (D E).
    const grid = [[[a!, b!], [c!]], [], [[d!, e!]]];
    expect(moveInWeek(grid, { day: 0, row: 0, slot: 0 }, "right")).toEqual({ day: 0, row: 0, slot: 1 });
    // Past the row's end, over the empty day, to the first logo of the next day's row.
    expect(moveInWeek(grid, { day: 0, row: 0, slot: 1 }, "right")).toEqual({ day: 2, row: 0, slot: 0 });
    expect(moveInWeek(grid, { day: 0, row: 1, slot: 0 }, "right")).toEqual({ day: 2, row: 0, slot: 0 });
    expect(moveInWeek(grid, { day: 2, row: 0, slot: 0 }, "left")).toEqual({ day: 0, row: 0, slot: 1 });
    expect(moveInWeek(grid, { day: 0, row: 0, slot: 1 }, "down")).toEqual({ day: 0, row: 1, slot: 0 });
    expect(moveInWeek(grid, { day: 0, row: 1, slot: 0 }, "down")).toBeNull();
    expect(moveInWeek(grid, { day: 2, row: 0, slot: 1 }, "right")).toBeNull();
  });
});
