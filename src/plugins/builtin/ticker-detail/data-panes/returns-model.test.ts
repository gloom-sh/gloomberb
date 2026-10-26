import { describe, expect, test } from "bun:test";
import type { ChartResolutionSupport } from "../../../../time-series/resolution";
import type { PricePoint } from "../../../../types/financials";
import {
  availableReturnResolutions,
  buildReturnRows,
  closedMarketNote,
  effectiveReturnResolution,
  isTodayReturnRow,
  returnBaseCloseDay,
  returnBaseDay,
  returnLookbackMs,
  returnTimeHeader,
  returnTimeText,
  returnRowsFrom,
  returnVisibleFrom,
  returnWindowEnd,
  returnWindowStart,
  summarizeReturns,
} from "./returns-model";

const point = (date: string, close: number, extra: Partial<PricePoint> = {}): PricePoint => ({ date: new Date(date), close, ...extra });

// AAPL hourly closes as Gloom Cloud served them on 2026-10-05 (bar-open times,
// regular session). The first bar sits just before the window.
const AAPL_1H: PricePoint[] = ([
  ["2026-09-30T19:30:00.000Z", 333.010009765625],
  ["2026-10-01T13:30:00.000Z", 330.9200134277344],
  ["2026-10-01T14:30:00.000Z", 328.5400085449219],
  ["2026-10-01T15:30:00.000Z", 328.4634094238281],
  ["2026-10-01T16:30:00.000Z", 328.8900146484375],
  ["2026-10-01T17:30:00.000Z", 329.69000244140625],
  ["2026-10-01T18:30:00.000Z", 329.7900085449219],
  ["2026-10-01T19:30:00.000Z", 330.4800109863281],
  ["2026-10-02T13:30:00.000Z", 334.3099060058594],
  ["2026-10-02T14:30:00.000Z", 332.34930419921875],
  ["2026-10-02T15:30:00.000Z", 332.864990234375],
  ["2026-10-02T16:30:00.000Z", 333.4136047363281],
  ["2026-10-02T17:30:00.000Z", 332.989990234375],
  ["2026-10-02T18:30:00.000Z", 333.2699890136719],
  ["2026-10-02T19:30:00.000Z", 333.7900085449219],
] as const).map(([date, close]) => point(date, close));

const WINDOW_START = Date.parse("2026-09-30T19:30:00.000Z");

function compounded(rows: ReturnType<typeof buildReturnRows>): number {
  return rows.reduce((product, row) => product * (1 + (row.intervalPercent ?? 0)), 1) - 1;
}

describe("buildReturnRows", () => {
  test("measures every return from the bar before the window, so the intervals compound to the total", () => {
    // Shuffled to check the order comes from the timestamps.
    const rows = buildReturnRows([...AAPL_1H].reverse(), WINDOW_START);

    expect(rows).toHaveLength(14);
    const [latest] = rows;
    const oldest = rows.at(-1)!;
    expect(oldest.timestamp).toBe(Date.parse("2026-10-01T13:30:00.000Z"));
    // 330.92 / 333.01 - 1 and 333.79 / 333.01 - 1, worked out by hand.
    expect(oldest.intervalPercent).toBeCloseTo(-0.0062761, 6);
    expect(oldest.cumulativePercent).toBeCloseTo(oldest.intervalPercent!, 12);
    expect(latest!.cumulativeChange).toBeCloseTo(0.78, 2);
    expect(latest!.cumulativePercent).toBeCloseTo(0.0023423, 6);
    // The overnight gap lands in the first bar of the next session.
    expect(rows.find((row) => row.timestamp === Date.parse("2026-10-02T13:30:00.000Z"))!.intervalPercent).toBeCloseTo(0.0115889, 6);
    expect(compounded(rows)).toBeCloseTo(latest!.cumulativePercent!, 12);
  });

  test("without the bar before the window, its first bar is the base and has no interval return", () => {
    const rows = buildReturnRows(AAPL_1H.slice(1), WINDOW_START);
    const oldest = rows.at(-1)!;

    expect(oldest).toMatchObject({ intervalChange: null, intervalPercent: null, cumulativeChange: 0, cumulativePercent: 0 });
    expect(compounded(rows)).toBeCloseTo(rows[0]!.cumulativePercent!, 12);
    expect(rows[0]!.cumulativePercent).toBeCloseTo(333.7900085449219 / 330.9200134277344 - 1, 12);
  });

  test("a contradictory bar and a zero base leave gaps instead of joining a longer move", () => {
    const rows = buildReturnRows([
      point("2026-01-01T00:00:00Z", 0),
      point("2026-01-02T00:00:00Z", 4),
      point("2026-01-03T00:00:00Z", 5, { high: 4, low: 3 }),
      point("2026-01-04T00:00:00Z", 6),
      point("2026-01-04T00:00:00Z", 6.5),
    ], Date.parse("2025-12-31T00:00:00Z"));

    expect(rows.map((row) => row.price)).toEqual([6.5, null, 4, 0]);
    expect(rows[1]).toMatchObject({ inconsistent: true, intervalPercent: null, cumulativeChange: null });
    // The bar after the gap has no interval: its previous bar has no price.
    expect(rows[0]).toMatchObject({ intervalChange: null, cumulativeChange: 6.5, cumulativePercent: null });
    expect(rows[2]).toMatchObject({ intervalChange: 4, intervalPercent: null, cumulativePercent: null });
  });
});

const CLOUD_SUPPORT: ChartResolutionSupport[] = [
  { resolution: "1m", maxRange: "1W" },
  { resolution: "5m", maxRange: "1M" },
  { resolution: "15m", maxRange: "3M" },
  { resolution: "30m", maxRange: "6M" },
  { resolution: "1h", maxRange: "1Y" },
  { resolution: "1d", maxRange: "5Y" },
  { resolution: "1wk", maxRange: "5Y" },
  { resolution: "1mo", maxRange: "ALL" },
];

describe("return windows", () => {
  test("never asks the source for an interval it does not serve, or past its usual history", () => {
    expect(availableReturnResolutions("1D", CLOUD_SUPPORT)).not.toContain("45m");
    expect(effectiveReturnResolution("1M", "1m", CLOUD_SUPPORT)).toBe("5m");
    expect(effectiveReturnResolution("ALL", "1h", CLOUD_SUPPORT)).toBe("1mo");
    expect(effectiveReturnResolution("5D", "1h", CLOUD_SUPPORT)).toBe("1h");

    const day = 24 * 60 * 60_000;
    // A weekend before the window is covered where the interval's history allows it...
    expect(returnLookbackMs("1D", "1m", CLOUD_SUPPORT)).toBe(4 * day);
    expect(returnLookbackMs("5D", "1h", CLOUD_SUPPORT)).toBe(4 * day);
    // ...and a minute-bar week already reaches the end of what is kept.
    expect(returnLookbackMs("1W", "1m", CLOUD_SUPPORT)).toBe(60_000);
    expect(returnLookbackMs("ALL", "1mo", CLOUD_SUPPORT)).toBe(31 * day);
  });

  test("daily bars from the window's start date are in it, intraday bars only after its start time", () => {
    const monday = Date.parse("2026-10-05T13:00:00Z");
    const days = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map((date, index) => point(`${date}T00:00:00Z`, 100 + index));
    const rows = buildReturnRows(days, returnVisibleFrom("5D", "1d", monday));
    // Five days before Monday is Wednesday: its session is in, Tuesday's close is the base.
    expect(rows.map((row) => new Date(row.timestamp).toISOString().slice(0, 10))).toEqual(["2026-10-02", "2026-10-01", "2026-09-30"]);
    expect(rows.at(-1)!.intervalChange).toBe(1);
    expect(returnVisibleFrom("5D", "1h", monday)).toBe(Date.parse("2026-09-30T13:00:00Z"));
  });

  test("1W to 5Y run from the close on or before the same date a range before, as CMP measures them", () => {
    const days = ["2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"].map((date, index) => point(`${date}T00:00:00Z`, 100 + index));
    const dates = (rows: ReturnType<typeof buildReturnRows>) => rows.map((row) => new Date(row.timestamp).toISOString().slice(0, 10)).reverse();
    // Wed 21 Oct's close: a month before is Mon 21 Sep, whose close is the base, so its own move is not in the month.
    const wednesday = Date.parse("2026-10-21T20:00:00Z");
    const month = buildReturnRows(days, returnVisibleFrom("1M", "1d", wednesday, "NASDAQ"));
    expect(dates(month)).toEqual(["2026-09-22", "2026-09-23"]);
    expect(month.at(-1)!.cumulativeChange).toBe(1);
    expect(returnBaseCloseDay(days, returnVisibleFrom("1M", "1d", wednesday, "NASDAQ"), "1d", "NASDAQ", wednesday)).toBe("2026-09-21");
    // Tue 20 Oct: a month before is Sun 20 Sep, so Fri 18 Sep's close.
    expect(dates(buildReturnRows(days, returnVisibleFrom("1M", "1d", Date.parse("2026-10-20T20:00:00Z"), "NASDAQ")))[0]).toBe("2026-09-21");
    // 31 Mar's month runs from 28 Feb; intraday bars run from the base day's session close.
    expect(returnBaseDay("1M", Date.parse("2026-03-31T20:00:00Z"), "NASDAQ")).toBe("2026-02-28");
    expect(returnVisibleFrom("1M", "1h", wednesday, "NASDAQ")).toBe(Date.parse("2026-09-21T20:00:00Z") - 1);
    // A week's bar (dated Monday) is the base when its Friday close is on or before the base day; a month's when its month ended by then.
    expect(new Date(returnVisibleFrom("1M", "1wk", Date.parse("2026-10-19T20:00:00Z"), "NASDAQ") + 1).toISOString().slice(0, 10)).toBe("2026-09-16");
    expect(new Date(returnVisibleFrom("1Y", "1mo", wednesday, "NASDAQ") + 1).toISOString().slice(0, 10)).toBe("2025-10-01");
    expect(new Date(returnWindowStart("6H", wednesday)).toISOString()).toBe("2026-10-21T14:00:00.000Z");
  });

  test("a feed stamping daily bars at local midnight keeps the base close, and today's bar, on the venue's dates", () => {
    // JPX bars stamped 00:00 JST, 15:00 UTC the day before: Fri 11, Mon 14, Tue 15 and Wed 16 Sep.
    const days = ["2026-09-10", "2026-09-13", "2026-09-14", "2026-09-15"].map((date, index) => point(`${date}T15:00:00Z`, 100 + index));
    // Wed 14 Oct's close (15:30 JST): a month before is Mon 14 Sep, whose bar is the base.
    const close = Date.parse("2026-10-14T06:30:00Z");
    const from = returnRowsFrom(days, "1M", "1d", close, "JPX");
    expect(buildReturnRows(days, from).map((row) => new Date(row.timestamp).toISOString()).reverse())
      .toEqual(["2026-09-14T15:00:00.000Z", "2026-09-15T15:00:00.000Z"]);
    expect(returnBaseCloseDay(days, from, "1d", "JPX", close)).toBe("2026-09-14");
    // Wed 14 Oct 11:00 JST, trading: the bar stamped 13 Oct 15:00 UTC is today's.
    expect(isTodayReturnRow({ timestamp: Date.parse("2026-10-13T15:00:00Z") }, "1d", "JPX", Date.parse("2026-10-14T02:00:00Z"))).toBe(true);
  });
});

describe("where a return window ends", () => {
  // VTI's last session before the weekend of Oct 10-11, 2026 closed Fri 20:00 UTC (16:00 New York).
  const FRIDAY_CLOSE = Date.parse("2026-10-09T20:00:00Z");

  test.each([
    ["an ETF on Sunday", { symbol: "VTI", exchange: "ARCA" }, "2026-10-11T15:00:00Z"],
    ["an ETF a day after the close", { symbol: "VTI", exchange: "ARCA" }, "2026-10-12T00:37:00Z"],
    ["a stock on Saturday", { symbol: "AAPL", exchange: "NASDAQ" }, "2026-10-10T09:00:00Z"],
  ])("%s ends at Friday's close", (_case, market, now) => {
    expect(returnWindowEnd(market, Date.parse(now))).toEqual({ end: FRIDAY_CLOSE, lastSession: "2026-10-09" });
  });

  test("a holiday ends the window at the session before it", () => {
    // Thanksgiving, Thu 26 Nov 2026: the last session is Wednesday's, closed 21:00 UTC.
    expect(returnWindowEnd({ symbol: "AAPL", exchange: "NASDAQ" }, Date.parse("2026-11-26T16:00:00Z")))
      .toEqual({ end: Date.parse("2026-11-25T21:00:00Z"), lastSession: "2026-11-25" });
  });

  test("an open market and a coin end now", () => {
    const tuesday = Date.parse("2026-10-13T15:00:00Z");
    expect(returnWindowEnd({ symbol: "VTI", exchange: "ARCA" }, tuesday)).toEqual({ end: tuesday });
    const sunday = Date.parse("2026-10-11T15:00:00Z");
    expect(returnWindowEnd({ symbol: "BTC-USD", exchange: "CCC" }, sunday)).toEqual({ end: sunday });
    // A bare coin pair names no venue and still trades around the clock.
    expect(returnWindowEnd({ symbol: "BTC-USD", exchange: "" }, sunday)).toEqual({ end: sunday });
  });

  test("spot FX ends at 17:00 New York on Friday until the week reopens on Sunday", () => {
    const saturday = Date.parse("2026-10-10T12:00:00Z");
    expect(returnWindowEnd({ symbol: "EURUSD=X", exchange: "" }, saturday))
      .toEqual({ end: Date.parse("2026-10-09T21:00:00Z"), lastSession: "2026-10-09" });
    // Sunday 20:37 New York: the week has reopened.
    const reopened = Date.parse("2026-10-12T00:37:00Z");
    expect(returnWindowEnd({ symbol: "EURUSD=X", exchange: "" }, reopened)).toEqual({ end: reopened });
  });

  test("a 5D window on Sunday covers Monday to Friday, not Wednesday to Friday", () => {
    const { end } = returnWindowEnd({ symbol: "VTI", exchange: "ARCA" }, Date.parse("2026-10-11T15:00:00Z"));
    const hours = [13, 14, 15, 16, 17, 18, 19];
    const days = ["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
    const bars = days.flatMap((date, day) => hours.map((hour, index) => point(`${date}T${hour}:30:00Z`, 380 + day + index / 10)));
    const rows = buildReturnRows(bars, returnVisibleFrom("5D", "1h", end));
    expect(rows).toHaveLength(35);
    expect(new Date(rows.at(-1)!.timestamp).toISOString()).toBe("2026-10-05T13:30:00.000Z");
    // Friday's last bar before the window is the base of the first return.
    expect(rows.at(-1)!.intervalChange).toBeCloseTo(381 - 380.6, 9);
  });

  test("the footer names the last session, with its year once it is another year's", () => {
    expect(closedMarketNote("2026-10-09", Date.parse("2026-10-11T15:00:00Z"))).toBe("market closed, last session Fri 9 Oct");
    expect(closedMarketNote("2026-12-31", Date.parse("2027-01-01T15:00:00Z"))).toBe("market closed, last session Thu 31 Dec 2026");
  });
});

describe("the time column", () => {
  const open = Date.parse("2026-10-23T13:30:00Z");

  test("an intraday bar is on its venue's clock, so the open reads 09:30 under ET, and UTC where the venue has no known clock", () => {
    expect(returnTimeText(open, "1h", "NASDAQ")).toBe("2026-10-23 09:30");
    expect(returnTimeHeader("1h", "NASDAQ")).toBe("TIME ET");
    // Standard time after the clocks change: the same open is an hour later in UTC.
    expect(returnTimeText(Date.parse("2026-11-02T14:30:00Z"), "1h", "NYSE")).toBe("2026-11-02 09:30");
    // The date is the venue's too: Tokyo's 09:00 open is the evening before in UTC.
    expect(returnTimeText(Date.parse("2026-10-22T00:00:00Z"), "1h", "JPX")).toBe("2026-10-22 09:00");
    expect(returnTimeHeader("1h", "JPX")).toBe("TIME TOKYO");
    // A coin, a pair and an unknown venue keep UTC, and an hourly bar at midnight keeps its time.
    expect(returnTimeText(Date.parse("2026-10-23T00:00:00Z"), "1h", undefined)).toBe("2026-10-23 00:00");
    expect(returnTimeHeader("1h", undefined)).toBe("TIME UTC");
    expect(returnTimeHeader("1h", "CCC")).toBe("TIME UTC");
  });

  test("a daily or longer bar is dated by its session, under the header its bars call for", () => {
    expect(returnTimeText(Date.parse("2026-10-23T00:00:00Z"), "1d", "NASDAQ")).toBe("2026-10-23");
    // A feed that stamps Tokyo's session at 00:00 JST sends 15:00 UTC the day before.
    expect(returnTimeText(Date.parse("2026-10-22T15:00:00Z"), "1d", "JPX")).toBe("2026-10-23");
    expect([returnTimeHeader("1d", "NASDAQ"), returnTimeHeader("1wk", "NASDAQ"), returnTimeHeader("1mo", "NASDAQ")]).toEqual(["DATE", "WEEK OF", "MONTH"]);
  });
});

describe("summarizeReturns", () => {
  const bars = (closes: number[]) => closes.map((close, index) => point(`2026-10-0${index + 1}T13:30:00Z`, close));

  test("names the window's total and its best and worst interval, newest first on a tie", () => {
    const rows = buildReturnRows(bars([100, 102, 99, 104, 104]), 0);
    const { total, best, worst } = summarizeReturns(rows);
    expect(total).toBeCloseTo(0.04, 12);
    expect(new Date(best!.timestamp).toISOString()).toBe("2026-10-04T13:30:00.000Z");
    expect(new Date(worst!.timestamp).toISOString()).toBe("2026-10-03T13:30:00.000Z");
    // Two intervals of the same size: the newest is named.
    const tied = summarizeReturns(buildReturnRows(bars([100, 110, 100, 110]), 0));
    expect(new Date(tied.best!.timestamp).toISOString()).toBe("2026-10-04T13:30:00.000Z");
  });

  test("a window with one interval, or only equal ones, has a total and no best or worst", () => {
    // The first bar is the base, so one more bar is one interval and the same as its total.
    expect(summarizeReturns(buildReturnRows(bars([100, 101]), 0))).toMatchObject({ best: null, worst: null });
    expect(summarizeReturns(buildReturnRows(bars([100, 100, 100]), 0))).toMatchObject({ total: 0, best: null, worst: null });
    expect(summarizeReturns([])).toEqual({ total: null, best: null, worst: null });
  });
});

