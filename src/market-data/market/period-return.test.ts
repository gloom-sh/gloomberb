import { describe, expect, test } from "bun:test";
import { isIntradayDailyBar, periodBaseDay, periodBaseIndex, periodBaseText, periodReturn, type PeriodClose } from "./period-return";

/** Weekday closes from `from` through `to`, skipping `closed` days, each 1 above the one before. */
function weekdayCloses(from: string, to: string, closed: readonly string[] = []): PeriodClose[] {
  const closes: PeriodClose[] = [];
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const weekday = new Date(time).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !closed.includes(day)) closes.push({ day, close: 100 + closes.length });
  }
  return closes;
}

describe("period base day", () => {
  test("a month back clamps to the shorter month's last day; a week is seven days; YTD is the prior 31 Dec", () => {
    expect(periodBaseDay("2026-10-21", "1M")).toBe("2026-09-21");
    expect(periodBaseDay("2026-03-31", "1M")).toBe("2026-02-28");
    expect(periodBaseDay("2028-03-31", "1M")).toBe("2028-02-29");
    expect(periodBaseDay("2026-05-31", "3M")).toBe("2026-02-28");
    expect(periodBaseDay("2026-08-31", "6M")).toBe("2026-02-28");
    expect(periodBaseDay("2028-02-29", "1Y")).toBe("2027-02-28");
    expect(periodBaseDay("2026-10-21", "1W")).toBe("2026-10-14");
    expect(periodBaseDay("2026-01-05", "YTD")).toBe("2025-12-31");
  });
});

describe("period return", () => {
  test("runs from the close on the base day when it traded", () => {
    const closes = weekdayCloses("2026-09-01", "2026-10-21");
    const month = periodReturn(closes, "1M")!;
    expect(month.baseDay).toBe("2026-09-21");
    expect(month.base.day).toBe("2026-09-21");
    expect(month.end.day).toBe("2026-10-21");
    expect(month.percent).toBeCloseTo((month.end.close / month.base.close - 1) * 100, 10);
  });

  test("a base day on a weekend or holiday takes the close before it, never the one after", () => {
    // A month before Tue 20 Oct is Sun 20 Sep: Fri 18 Sep's close.
    const closes = weekdayCloses("2026-09-01", "2026-10-20");
    expect(periodReturn(closes, "1M")!.base.day).toBe("2026-09-18");
    // Labor Day, Mon 7 Sep 2026: a month before Wed 7 Oct is measured from Fri 4 Sep.
    const holiday = weekdayCloses("2026-08-20", "2026-10-07", ["2026-09-07"]);
    expect(periodReturn(holiday, "1M")!.base.day).toBe("2026-09-04");
    // YTD from the last close of the prior year: 31 Dec 2022 was a Saturday.
    expect(periodReturn(weekdayCloses("2022-12-20", "2023-03-01"), "YTD")!.base.day).toBe("2022-12-30");
  });

  test("a live price ends the period on its own day", () => {
    const closes = weekdayCloses("2026-09-01", "2026-10-20");
    const live = periodReturn(closes, "1M", { day: "2026-10-21", close: 200 })!;
    expect(live.base.day).toBe("2026-09-21");
    expect(live.end).toEqual({ day: "2026-10-21", close: 200 });
  });

  test("no base when the history starts after the base day or leaves a gap longer than a closure there", () => {
    // A listing that started trading on Mon 28 Sep has no 1M yet.
    expect(periodReturn(weekdayCloses("2026-09-28", "2026-10-21"), "1M")).toBeNull();
    // A halt from 4 Sep to 25 Sep: the last close before 21 Sep is 17 days back.
    const halted = [...weekdayCloses("2026-08-01", "2026-09-03"), ...weekdayCloses("2026-09-25", "2026-10-21")];
    expect(periodReturn(halted, "1M")).toBeNull();
    expect(periodBaseIndex(halted.map((close) => close.day), "2026-09-21", Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(0);
    // Spring Festival: TWSE's previous session can be twelve days back, which is still a base.
    const festival = [...weekdayCloses("2026-01-20", "2026-02-11"), ...weekdayCloses("2026-02-23", "2026-03-20")];
    expect(periodReturn(festival, "1M")!.base.day).toBe("2026-02-11");
    expect(periodReturn([], "1M")).toBeNull();
  });

  test("names its base close with the year only when it is not the current one", () => {
    const now = Date.parse("2026-10-21T18:48:00Z");
    expect(periodBaseText("2026-09-21", now)).toBe("from Mon 21 Sep close");
    expect(periodBaseText("2025-10-21", now)).toBe("from Tue 21 Oct 2025 close");
  });
});

test("today's daily bar is intraday until its session closes", () => {
  // Wed 21 Oct 2026 18:48 UTC: New York is trading.
  const open = Date.parse("2026-10-21T18:48:00Z");
  expect(isIntradayDailyBar("2026-10-21", "NASDAQ", open)).toBe(true);
  expect(isIntradayDailyBar("2026-10-20", "NASDAQ", open)).toBe(false);
  // After the close, and the next morning before the open, the bar is the close.
  expect(isIntradayDailyBar("2026-10-21", "NASDAQ", Date.parse("2026-10-21T21:00:00Z"))).toBe(false);
  expect(isIntradayDailyBar("2026-10-21", "NASDAQ", Date.parse("2026-10-22T05:00:00Z"))).toBe(false);
  // A venue whose sessions are unknown cannot tell.
  expect(isIntradayDailyBar("2026-10-21", undefined, open)).toBe(false);
});
