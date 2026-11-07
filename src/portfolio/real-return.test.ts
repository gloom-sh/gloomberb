import { expect, test } from "bun:test";
import { CPI_SOURCES, inflationMethodText, periodInflation, realReturn } from "./real-return";

const month = (date: string, value: number | null) => ({ date: `${date}-01`, value });

test("a lira book's CPI is TurkStat's year-on-year change for a whole year, chained with the monthly changes of the months left", () => {
  // Monthly changes in percent, Oct 2025 to Oct 2026, as the central bank's table gives TurkStat's.
  const months = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
  const changes = [2.55, 0.87, 0.89, 4.84, 2.96, 1.94, 4.18, 1.71, 1.37, 2.06, 2.04, 3.23, 2.55];
  const monthly = months.map((at, index) => month(at, changes[index]!));
  // The year-on-year change TurkStat computes from the index level; the monthly ones, rounded, chain to 29.76.
  const yearly = [month("2026-09", 30.12), month("2026-10", 29.77)];
  const year = periodInflation(CPI_SOURCES.TRY!, monthly, { from: "2025-11-06", to: "2026-11-06" }, yearly)!;
  expect(year).toMatchObject({ fromMonth: "2025-10", toMonth: "2026-10", latestPublished: false, readings: [{ series: "TURCPIYOY", month: "2026-10", value: 29.77 }] });
  expect(year.inflation).toBeCloseTo(0.2977, 12);
  expect(inflationMethodText(year)).toBe("TurkStat's year-on-year change");
  // Thirteen months: the year to October 2026, then November 2025's own change before it.
  const longer = periodInflation(CPI_SOURCES.TRY!, [month("2025-09", 3.23), ...monthly], { from: "2025-10-06", to: "2026-11-06" }, yearly)!;
  expect(longer.readings.map((row) => `${row.series} ${row.month}`)).toEqual(["TURCPIMOM 2025-10", "TURCPIYOY 2026-10"]);
  expect(longer.inflation).toBeCloseTo(1.0255 * 1.2977 - 1, 12);
  expect(inflationMethodText(longer)).toBe("TurkStat's year-on-year change and monthly change chained");
  // Under a year the monthly changes after April's chain, May to October; a missing one leaves the period unpriced.
  const half = periodInflation(CPI_SOURCES.TRY!, monthly, { from: "2026-05-02", to: "2026-11-06" }, yearly)!;
  expect(half.inflation).toBeCloseTo(changes.slice(7).reduce((index, change) => index * (1 + change / 100), 1) - 1, 12);
  expect(periodInflation(CPI_SOURCES.TRY!, monthly.filter((row) => row.date !== "2026-07-01"), { from: "2026-05-02", to: "2026-11-06" })).toBeNull();
  expect(realReturn(0.4542, year.inflation)).toBeCloseTo(1.4542 / 1.2977 - 1, 12);
});

test("a dollar book's CPI is the index level, a month with no value reads the one before, and an unpublished end the latest", () => {
  // The BLS published no October 2025 CPI.
  const levels = [month("2025-09", 324.245), month("2025-10", null), month("2025-11", 325.063), month("2026-09", 336.298)];
  const read = periodInflation(CPI_SOURCES.USD!, levels, { from: "2025-11-06", to: "2026-11-06" })!;
  expect(read).toMatchObject({ fromMonth: "2025-09", toMonth: "2026-09", latestPublished: true });
  expect(read.inflation).toBeCloseTo(336.298 / 324.245 - 1, 12);
  // A series that starts after the period's first month cannot price it.
  expect(periodInflation(CPI_SOURCES.USD!, levels.slice(2), { from: "2025-11-06", to: "2026-11-06" })).toBeNull();
});
