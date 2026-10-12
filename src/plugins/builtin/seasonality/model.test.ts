import { describe, expect, test } from "bun:test";
import { projectSeasonality, projectWeekdays } from "./model";

const bar = (iso: string, close: number) => ({ date: new Date(`${iso}T00:00:00Z`), close });

describe("projectSeasonality", () => {
  test("a month runs from the previous month's last close, across the year boundary", () => {
    const model = projectSeasonality([
      bar("2022-12-15", 90), bar("2022-12-30", 100),
      bar("2023-01-03", 101), bar("2023-01-31", 110),
      bar("2023-02-28", 99), bar("2023-12-29", 120),
    ], { symbol: "X", lookbackYears: 5 });
    const [y2023, y2022] = model.years;
    expect(y2023!.months[0]).toBeCloseTo(0.1);
    expect(y2023!.months[1]).toBeCloseTo(-0.1);
    // March to November have no closes; December has no November close to start from.
    expect(y2023!.months.slice(2)).toEqual(Array(10).fill(null));
    expect(y2023!.total).toBeCloseTo(0.2);
    expect(y2023!.partial).toBe(false);
    // The first year has no prior year-end, and its first month no prior month.
    expect(y2022!.total).toBeNull();
    expect(y2022!.months[11]).toBeNull();
  });

  test("the month in progress shows in its year but stays out of the month statistics", () => {
    const model = projectSeasonality([
      bar("2023-12-29", 100), bar("2024-01-31", 110), bar("2024-02-29", 121),
      bar("2024-12-31", 100), bar("2025-01-31", 90), bar("2025-02-10", 99),
    ], { symbol: "X", lookbackYears: 5 });
    expect(model.years[0]!.partial).toBe(true);
    expect(model.years[0]!.months[1]).toBeCloseTo(0.1);
    const [jan, feb] = model.months;
    expect(jan).toMatchObject({ count: 2, hitRate: 0.5 });
    expect(jan!.mean).toBeCloseTo(0);
    expect(feb).toMatchObject({ count: 1, hitRate: 1 });
    // The running year's path is drawn but left out of the average.
    expect(model.paths.map((path) => path.year)).toEqual([2025, 2024]);
    expect(model.paths[0]!.points.at(-1)!.date.toISOString().slice(0, 10)).toBe("2000-02-10");
    expect(model.averagePath.map((point) => point.value.toFixed(2))).toEqual(["0.00", "0.10", "0.21", "0.00"]);
  });

  test("monthly bars stamped at the month start give the same months, and the average skips months a year lacks", () => {
    const model = projectSeasonality([
      bar("2021-12-01", 100), bar("2022-01-01", 110), bar("2022-02-01", 121), bar("2022-12-01", 100),
      bar("2023-01-01", 90), bar("2023-12-01", 100),
    ], { symbol: "X", lookbackYears: 5 });
    expect(model.years[0]!.partial).toBe(false);
    expect(model.years[1]!.months[0]).toBeCloseTo(0.1);
    // Both years have January (+10%, -10%) and December (0%); 2023 has no February, so it is skipped.
    expect(model.averagePath.map((point) => [point.date.toISOString().slice(0, 10), point.value.toFixed(2)]))
      .toEqual([["2000-01-01", "0.00"], ["2000-01-31", "0.00"], ["2000-12-31", "0.00"]]);
    expect(projectSeasonality([], { symbol: "X", lookbackYears: 5 }).years).toEqual([]);
  });

  test("a weekly bar stamped on the Monday of a month's last days counts toward the month its Friday closes in", () => {
    // Week of Mon Dec 31 2018 closes Fri Jan 4 2019: it is January's first week, not December's last.
    const weeks = [["2018-12-17", 100], ["2018-12-24", 100], ["2018-12-31", 90], ["2019-01-07", 95], ["2019-01-14", 99], ["2019-01-21", 99],
      ["2019-01-28", 110], ["2019-02-04", 111]] as const;
    const model = projectSeasonality(weeks.map(([iso, close]) => bar(iso, close)), { symbol: "X", lookbackYears: 5 });
    // Jan runs from the Dec 28 close (100) to the Jan 25 close (99): the week of Jan 28 closes in February.
    // Stamped by its Monday, January would run from 90 to 110.
    expect(model.years.find((year) => year.year === 2019)!.months[0]).toBeCloseTo(-0.01);
  });
});

describe("projectWeekdays", () => {
  test("files each session under the venue's date and counts a month's place only once its start is seen", () => {
    // Tokyo bars stamped at local midnight: Thu Feb 1 is 15:00 UTC on Wed Jan 31.
    // Read in UTC every session would land a day early, Feb 1 under January.
    const sessions = [["01-29", 100], ["01-30", 101], ["01-31", 100], ["02-01", 102], ["02-02", 101], ["02-05", 103],
      ["02-06", 104], ["02-07", 102], ["02-08", 105]] as const;
    const model = projectWeekdays(sessions.map(([day, close]) => ({ date: new Date(`2024-${day}T00:00:00+09:00`), close })),
      { symbol: "7203", exchange: "JPX", fetchedAt: Date.UTC(2024, 2, 1) });
    expect([model.start, model.asOf]).toEqual(["2024-01-30", "2024-02-08"]);
    // Thursday holds Feb 1 (+2%) and Feb 8 (105 / 102).
    expect(model.weekdays.map((stat) => `${stat.day} ${stat.count}`)).toEqual(["Mon 1", "Tue 2", "Wed 2", "Thu 2", "Fri 1"]);
    expect(model.weekdays[3]!.mean).toBeCloseTo((0.02 + 105 / 102 - 1) / 2);
    // Jan 30 could be any day of January, and Feb 8 could still be February's last
    // session: both stay out of the split. Jan 31 is the last day; Feb 1, 2 and 5 days 1 to 3.
    expect(model.turnOfMonth.map((stat) => stat.count)).toEqual([1, 1, 1, 1]);
    expect(model.turnOfMonth.map((stat) => stat.mean!.toFixed(4))).toEqual(["-0.0099", "0.0200", "-0.0098", "0.0198"]);
    expect(model.turnWindow.count).toBe(4);
    expect(model.otherDays).toMatchObject({ count: 2, hitRate: 0.5 });
    // Weekly bars would put a week's move under one weekday.
    const weekly = projectWeekdays(sessions.map(([, close], index) => ({ date: new Date(Date.UTC(2024, 0, 1 + 7 * index)), close })),
      { symbol: "X", fetchedAt: Date.UTC(2024, 6, 1) });
    expect(weekly.start).toBeNull();
  });

  test("leaves out a session still trading when the history was fetched, and keeps the venue's own week", () => {
    const daily = (from: string, to: string, keep: (weekday: number) => boolean) => {
      const bars = [];
      for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86_400_000) {
        if (keep(new Date(time).getUTCDay())) bars.push({ date: new Date(time), close: 100 + bars.length });
      }
      return bars;
    };
    const weekdays = (from: string, to: string) => daily(from, to, (day) => day > 0 && day < 6);
    // Thursday Feb 8: the New York session runs to 16:00, and its bar settles half an hour later.
    expect(projectWeekdays(weekdays("2024-02-05", "2024-02-08"), { symbol: "AAPL", fetchedAt: Date.parse("2024-02-08T18:00:00Z") }).asOf)
      .toBe("2024-02-07");
    expect(projectWeekdays(weekdays("2024-02-05", "2024-02-08"), { symbol: "AAPL", fetchedAt: Date.parse("2024-02-08T21:31:00Z") }).asOf)
      .toBe("2024-02-08");
    // A coin's daily bar is a UTC day; Saturday's is still running at noon.
    const coin = projectWeekdays(daily("2024-02-03", "2024-02-10", () => true), { symbol: "BTC-USD", fetchedAt: Date.parse("2024-02-10T12:00:00Z") });
    expect([coin.asOf, coin.weekdays.map((stat) => stat.day).join(" ")]).toEqual(["2024-02-09", "Mon Tue Wed Thu Fri Sun"]);
    // Tadawul trades Sunday to Thursday.
    const riyadh = projectWeekdays(daily("2024-02-04", "2024-02-15", (day) => day < 5), { symbol: "2222.SR", fetchedAt: Date.UTC(2024, 2, 1) });
    expect(riyadh.weekdays.map((stat) => `${stat.day} ${stat.count}`)).toEqual(["Sun 1", "Mon 2", "Tue 2", "Wed 2", "Thu 2"]);
  });
});
