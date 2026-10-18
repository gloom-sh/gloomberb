import { describe, expect, test } from "bun:test";
import {
  cleanFloat32Price, closedPeriodBarDay, formingPeriodBar, historyBarStatusNote, historyFlagNote, historyGapNote, historyJumpNote, historyMissingVolumeNote,
  historyNotes, historyPriceDecimals,
  historyRows, historyUnbrokenFrom, historyUnit,
} from "./history-rows";
import { mapPricePoint } from "../sources/gloomberb-cloud/normalizers";
import { latestTradeIndex, missingVolumeCount, pricePointValues } from "../utils/price-history-integrity";
import type { ManualChartResolution } from "../time-series/resolution";
import { rowsFreshness } from "./freshness";
import { formatFreshnessLine } from "./pane-functions/freshness";
import { barHistoryFreshness } from "../plugins/builtin/shared/report-freshness";

const daily = (bars: number[][]) => historyRows(bars.map(([open, high, low, close], index) => ({
  date: new Date(Date.UTC(2026, 0, index + 1)), open, high, low, close: close!,
})), "1d");

/** USDILS=X monthly as the source served it: 34 old-shekel bars, 148 months without one, then new shekels. */
const usdIlsMonthly = () => [
  ...Array.from({ length: 34 }, (_, month) => ({ date: new Date(Date.UTC(1977, 9 + month, 1)), close: Number((0.0015 + month * 0.0034 / 33).toFixed(4)) })),
  ...[2.763, 2.762, 2.795].map((close, month) => ({ date: new Date(Date.UTC(1992, 11 + month, 1)), close })),
];

/** Bars at `step` from `first` to `last`, skipping those `skip` says, with a close that swings between 80 and 120. */
const series = (first: string, last: string, step: number, skip: (date: Date) => boolean = () => false) => {
  const points: Array<{ date: Date; close: number }> = [];
  for (let time = Date.parse(first); time <= Date.parse(last); time += step) {
    if (!skip(new Date(time))) points.push({ date: new Date(time), close: 100 + 20 * Math.sin(time / 4e8) });
  }
  return points;
};
const DAY = 86_400_000;
const weekend = (date: Date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;
const between = (date: Date, from: string, to: string) => date.toISOString().slice(0, 10) >= from && date.toISOString().slice(0, 10) <= to;

describe("history rows", () => {
  test("float32 noise from either source becomes the intended decimal while real precision stays", () => {
    // The feed sends the exact float32.
    expect(cleanFloat32Price(Math.fround(340.33))).toBe(340.33);
    expect(cleanFloat32Price(Math.fround(109556.16))).toBe(109556.16);
    expect(cleanFloat32Price(Math.fround(0.00000537))).toBe(0.00000537);
    // Cloud daily sends the float32 already rounded to five or six decimals.
    expect([254.42999, 251.039993, 255.74001, 377.059998].map(cleanFloat32Price)).toEqual([254.43, 251.04, 255.74, 377.06]);
    // Doubles, FX quotes and sub-cent coins that are already the shortest form keep every digit.
    for (const value of [750123.45, 342.615, 1.147934, 1.1801081, 0.0000053712]) expect(cleanFloat32Price(value)).toBe(value);
  });

  test("intraday bars keep their UTC time; daily bars stay trading dates", () => {
    const intraday = historyRows([
      { date: new Date("2026-09-22T13:30:00Z"), close: 1 },
      { date: new Date("2026-09-22T13:35:00Z"), close: 1 },
    ], "5m");
    expect(intraday.map((row) => row.date)).toEqual(["2026-09-22T13:30:00Z", "2026-09-22T13:35:00Z"]);
    // Without a declared cadence, spacing decides: daily bars stamped at the session open stay dates.
    const sessionOpens = ["2026-09-21T13:30:00Z", "2026-09-22T13:30:00Z", "2026-09-23T13:30:00Z"];
    expect(historyRows(sessionOpens.map((date) => ({ date: new Date(date), close: 1 })), null).map((row) => row.date))
      .toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
    expect(historyRows([{ date: new Date("2026-09-22T15:00:00Z"), close: 1 }, { date: new Date("2026-09-22T15:15:00Z"), close: 1 }], null)[1]!.date)
      .toBe("2026-09-22T15:15:00Z");
  });

  test("a bar HP blanks is blanked the same way and says which prices disagree", () => {
    // SBK.JO 2025-10-09 as served: the low is above the open.
    const points = [
      { date: new Date("2025-10-09"), open: 245.86, high: 253.3, low: 246.23, close: 252.46, volume: 3018311 },
      { date: new Date("2025-10-10"), open: 249, high: 248, low: 247, close: 250, volume: 1 },
      { date: new Date("2025-10-13"), open: 255, high: 255.97, low: 251.07, close: 254.02, volume: 1854180 },
    ];
    const rows = historyRows(points, "1d", "ZAR");
    expect(rows.map((row) => row.flag)).toEqual(["low>open", "high<open,high<close", null]);
    for (const [index, row] of rows.entries()) {
      const { open, high, low, close, volume } = pricePointValues(points[index]!);
      expect([row.open, row.high, row.low, row.close, row.volume]).toEqual([open, high, low, close, volume]);
    }
    expect(rows[2]).toMatchObject({ close: 254.02, currency: "ZAR", interval: "1d" });
    expect(historyFlagNote(rows)).toBe("2 of 3 bars have high below open or close, or low above open or close in the source data; their prices are left blank");
    expect(historyFlagNote([rows[2]!])).toBeNull();
  });

  test("a coin's 0 volume is missing, never 0, and counted once; a stock's 0 is a real 0", () => {
    // A coin's hourly bars where a source sent 0 for hours it did not report: the 0 is no volume reported.
    const served = [{ date: "2026-10-11T00:00:00Z", open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { date: "2026-10-11T01:00:00Z", open: 1, high: 1, low: 1, close: 1, volume: 10_060_800 },
      { date: "2026-10-11T02:00:00Z", open: 1, high: 1, low: 1, close: 1, volume: 0 }];
    const coin = historyRows(served.map((point) => mapPricePoint(point, 1, "CCC", true)), "1h");
    expect(coin.map((row) => row.volume)).toEqual([null, 10_060_800, null]);
    expect(historyMissingVolumeNote(coin)).toBe("2 of 3 bars have no reported volume (\u2014)");
    // A thin stock can trade nothing in an hour: its 0 stays 0 and is not missing.
    const stock = historyRows(served.map((point) => mapPricePoint(point, 1, "NASDAQ")), "1h");
    expect(stock.map((row) => row.volume)).toEqual([0, 10_060_800, 0]);
    expect(historyMissingVolumeNote(stock)).toBeNull();
    // A history with no volume at all (an index, a currency pair) has nothing to mark, and a day still forming says so itself.
    expect(historyMissingVolumeNote(historyRows(served.map(({ volume: _, ...point }) => mapPricePoint(point, 1, "CCC", true)), "1h"))).toBeNull();
    expect(historyMissingVolumeNote([coin[1]!, { ...coin[0]!, partial: true }])).toBeNull();
  });

  test("the latest trade a coin's intraday history ends with is part of the bar before it, never a bar without volume", () => {
    // Hourly bars as Gloom Cloud serves a coin signed in: each bar's volume, then the latest trade at its own time.
    const bar = (date: string, volume?: number) => ({ date, open: 81_000, high: 81_100, low: 80_900, close: 81_050, volume });
    const served = [bar("2026-10-18T13:00:00Z", 61_200_000), bar("2026-10-18T14:00:00Z", 73_800_000),
      bar("2026-10-18T15:00:00Z", 24_100_000), bar("2026-10-18T15:57:53Z")];
    const rows = historyRows(served.map((point) => mapPricePoint(point, 1, "CCC", true)), "1h", "USD", "USD", { unit: "USD" });
    expect(rows.at(-1)).toMatchObject({ date: "2026-10-18T15:57:53Z", volume: null, volumeNote: "latest trade" });
    // Before: "1 of 4 bars has no reported volume (\u2014)" on every signed-in coin history.
    expect(historyMissingVolumeNote(rows)).toBeNull();
    expect(historyBarStatusNote(rows)).toBe("2026-10-18T15:57:53Z is the latest trade, inside the bar before it, with no volume of its own");
    // A bar without volume of its own is still counted, the latest trade beside it is not.
    const hole = rows.map((row, index) => index === 1 ? { ...row, volume: null } : row);
    expect(historyMissingVolumeNote(hole)).toBe("1 of 4 bars has no reported volume (\u2014)");
    // fn HP (ISO dates, oldest first) and the HP pane (times, newest first) count the same.
    expect(missingVolumeCount(hole)).toBe(1);
    expect(missingVolumeCount([...hole].reverse().map((row) => ({ ...row, date: Date.parse(row.date) })))).toBe(1);
    expect(missingVolumeCount(rows)).toBe(0);
    // The newest bar on the grid is a bar, however little time it has run: 15:00 after 14:00 is counted.
    const onGrid = historyRows(served.slice(0, 3).map((point, index) => mapPricePoint(index === 2 ? { ...point, volume: 0 } : point, 1, "CCC", true)), "1h");
    expect(historyMissingVolumeNote(onGrid)).toBe("1 of 3 bars has no reported volume (\u2014)");
    expect(historyBarStatusNote(onGrid)).toBeNull();
    // Minute bars end with one too; daily bars stamped at a session open, or two points, have none.
    const minutes = [Date.parse("2026-10-18T15:55:00Z"), Date.parse("2026-10-18T15:56:00Z"), Date.parse("2026-10-18T15:57:00Z"),
      Date.parse("2026-10-18T15:57:53Z")];
    expect(latestTradeIndex(minutes)).toBe(3);
    expect(latestTradeIndex(["2026-10-14T13:30:00Z", "2026-10-15T13:30:00Z", "2026-10-16T13:30:00Z", "2026-10-16T20:00:00Z"].map(Date.parse))).toBe(-1);
    expect(latestTradeIndex(minutes.slice(2))).toBe(-1);
  });

  test("notes bars coarser than the range is served in, or a first bar well after the start asked for", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    // A listing younger than the range starts late; weekends and a holiday at the start do not.
    expect(historyNotes("5Y", "1wk", "2023-09-11", now)).toEqual(["Asked 5Y, data starts 2023-09-11 (first available bar)"]);
    expect(historyNotes("1Y", "1d", "2025-10-13", now)).toEqual([]);
    expect(historyNotes("5Y", "1wk", "2021-10-25", now)).toEqual([]);
    // ALL has no start to miss, and monthly is what it is served in.
    expect(historyNotes("ALL", "1mo", "1976-12-01", now)).toEqual([]);
    expect(historyNotes("1Y", "1mo", "2025-10-01", now)).toEqual(["Asked 1Y, got monthly bars from 2025-10"]);
    // Without a declared size, the bars' spacing says what they are.
    const weekly = historyRows([0, 7, 14].map((day) => ({ date: new Date(Date.UTC(2026, 0, 5 + day)), close: 1 })), null);
    expect(weekly[0]!.interval).toBe("1wk");
    expect(historyNotes("6M", weekly[0]!.interval, weekly[0]!.date, now)).toContain("Asked 6M, got weekly bars from 2026-01-05");
  });

  test("a coin's day without a bar is named; a market's weekends and the days before a listing are not", () => {
    const days = (first: string, last: string, skip: string[] = []) => {
      const dates: Date[] = [];
      for (let time = Date.parse(first); time <= Date.parse(last); time += 86_400_000) {
        if (!skip.includes(new Date(time).toISOString().slice(0, 10))) dates.push(new Date(time));
      }
      return historyRows(dates.map((date) => ({ date, close: 1 })), "1d");
    };
    const btc = { listing: "BTC-USD", exchange: "CCC", instrumentType: "CRYPTOCURRENCY" };
    // The coin's daily bars went from 9 Oct to 11 Oct; a coin listed mid-range starts late without a gap.
    expect(historyGapNote(days("2026-09-11", "2026-10-11", ["2026-10-10"]), btc)).toBe("No bar for 2026-10-10");
    expect(historyGapNote(days("2026-10-02", "2026-10-11"), { listing: "NEW-USD" })).toBeNull();
    // A coin named by its listing type alone counts too; several gaps fold into one line.
    expect(historyGapNote(
      days("2026-08-01", "2026-10-11", ["2026-08-03", "2026-08-20", "2026-09-30", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-10"]),
      { listing: "BTC-EUR", instrumentType: "CRYPTOCURRENCY" },
    )).toBe("No bars for 2 earlier days, 2026-09-30, 2026-10-04 to 2026-10-06 and 2026-10-10");
    // A stock's weekend, and a coin's weekly bars, are no gap.
    const weekdays = days("2026-09-28", "2026-10-09", ["2026-10-03", "2026-10-04"]);
    expect(historyGapNote(weekdays, { listing: "AAPL", exchange: "NASDAQ", instrumentType: "EQUITY" })).toBeNull();
    const weekly = historyRows([0, 7, 21].map((day) => ({ date: new Date(Date.UTC(2026, 8, 7 + day)), close: 1 })), "1wk");
    expect(historyGapNote(weekly, btc)).toBeNull();
  });

  test("a gap or a 100x jump flags the bar after it and keeps its prices, which the blanked-bar count leaves out", () => {
    const rows = historyRows(usdIlsMonthly(), "1mo", "ILS", "ILS per USD");
    expect(rows.filter((row) => row.flag).map((row) => [row.date, row.flag, row.close])).toEqual([["1992-12-01", "gap,jump", 2.763]]);
    expect(historyFlagNote(rows)).toBeNull();
    const blanked = historyRows([{ date: new Date("1977-09-01"), open: 0.0015, high: 0.0014, low: 0.0014, close: 0.0015 }, ...usdIlsMonthly()], "1mo");
    expect(historyFlagNote(blanked)).toBe("1 of 38 bars has high below open or close in the source data; their prices are left blank");
    // A daily series breaks where its weekly bars would: Athens shut for five weeks in 2015, and a fall is a jump too.
    const athens = historyRows([
      ...series("2015-06-22", "2015-06-26", DAY), ...series("2015-08-03", "2015-08-05", DAY), { date: new Date("2015-08-06"), close: 0.5 },
    ], "1d");
    expect(athens.filter((row) => row.flag).map((row) => [row.date, row.flag])).toEqual([["2015-08-03", "gap"], ["2015-08-06", "jump"]]);
    expect(historyGapNote(athens, { listing: "ETE.AT" })).toBe("No bars for 2015-06-27 to 2015-08-02 (5 weeks)");
    expect(historyJumpNote(athens)).toMatch(/^Close falls \d+x from [\d.]+ on 2015-08-05 to 0.5 on 2015-08-06$/);
    expect(historyUnbrokenFrom(athens)).toBe("2015-08-06");
  });

  test("closures, thin trading and round-the-clock coins are no break", () => {
    const cases: Array<[string, ReturnType<typeof series>, ManualChartResolution, { listing: string; exchange?: string; instrumentType?: string }]> = [
      // AAPL's year: weekends and a four-day Easter.
      ["daily", series("2025-10-13", "2026-10-12", DAY, (date) => weekend(date) || between(date, "2026-04-03", "2026-04-06")), "1d", { listing: "AAPL" }],
      // Lunar New Year shuts Shanghai for nine days; a thin listing goes two weeks without a trade.
      ["closures", series("2026-01-05", "2026-04-30", DAY, (date) => weekend(date) || between(date, "2026-02-14", "2026-02-23")
        || between(date, "2026-03-09", "2026-03-20")), "1d", { listing: "600519.SS" }],
      ["weekly", series("2021-10-04", "2026-10-05", 7 * DAY, (date) => between(date, "2025-09-29", "2025-10-06")), "1wk", { listing: "600519.SS" }],
      ["monthly", series("1990-01-01", "2026-10-01", 30.44 * DAY, (date) => between(date, "2001-09-01", "2001-10-31")), "1mo", { listing: "GC=F" }],
      // 5-minute bars of a Friday and Monday session, hourly bars across a week's nights.
      ["5-minute", series("2026-10-09T13:30:00Z", "2026-10-12T19:55:00Z", 5 * 60_000, (date) => weekend(date)
        || date.getUTCHours() < 13 || date.getUTCHours() >= 20), "5m", { listing: "AAPL" }],
      ["hourly", series("2026-10-05T13:00:00Z", "2026-10-09T19:00:00Z", 3_600_000, (date) => date.getUTCHours() < 13 || date.getUTCHours() > 19), "1h", { listing: "AAPL" }],
      // A coin trades every day; a thin one misses hours.
      ["crypto", series("2025-10-13", "2026-10-12", DAY), "1d", { listing: "BTC-USD", exchange: "CCC" }],
      ["crypto hourly", series("2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z", 3_600_000, (date) => date.getUTCHours() % 5 === 0), "1h",
        { listing: "PEPE-USD", exchange: "CCC" }],
    ];
    for (const [name, points, interval, market] of cases) {
      const rows = historyRows(points, interval);
      expect([name, rows.filter((row) => row.flag).length, historyGapNote(rows, market), historyJumpNote(rows), historyUnbrokenFrom(rows)])
        .toEqual([name, 0, null, null, null]);
    }
  });

  test("prices are in the quote's currency, an FX pair's counter currency, or index points, and never a guessed one", () => {
    expect(historyUnit("ZAR=X", null)).toEqual({ kind: "pair", currency: "ZAR", unit: "ZAR per USD" });
    for (const listing of ["EURUSD=X", "EUR/USD", "EURUSD:CCY"]) {
      expect(historyUnit(listing, { currency: "USD" })).toEqual({ kind: "pair", currency: "USD", unit: "USD per EUR" });
    }
    expect(historyUnit("LUMI.TA", { currency: "ILA" }).unit).toBe("ILA (agorot, 1/100 ILS)");
    expect(historyUnit("^GSPC", { currency: "USD", instrumentType: "INDEX" })).toEqual({ kind: "points", currency: null, unit: "index points" });
    expect(historyUnit("LUMI.TA", null)).toEqual({ kind: "unknown", currency: null, unit: null });
  });

  test("one decimal count per table that neither pads BTC nor zeroes sub-cent coins", () => {
    // Cloud AAPL daily, with one bar carrying a genuine sub-penny print.
    expect(historyPriceDecimals(daily([
      [255.88, 257.34, 253.58, 254.42999], [255.22, 255.74001, 251.039993, 252.31],
      [253.21001, 257.17001, 251.71001, 256.87], [254.1, 257.6, 253.7812, 255.46],
    ]))).toBe(2);
    expect(historyPriceDecimals(daily([[73031.086, 79463.71, 73011.414, 78335.19], [78332.555, 78801.15, 76526.71, 77083.414]]))).toBe(2);
    expect(historyPriceDecimals(daily([[1.1684973, 1.1691804, 1.1660856, 1.168156], [1.1668475, 1.1675423, 1.1651752, 1.1668339]]))).toBe(6);
    const shib = [[0.00000537, 0.00000539, 0.00000537, 0.00000539], [0.00000539, 0.00000546, 0.00000538, 0.00000546]];
    expect(historyPriceDecimals(daily(shib.map((bar) => bar.map(Math.fround))))).toBe(8);
    // A known kind applies the app's price rules: an equity shows cents even with sub-penny prints.
    expect(historyPriceDecimals(daily([[334.5795, 335.48, 333.1697, 334.225], [334.26, 334.1216, 332.8706, 333.8972]]), "STK")).toBe(2);
  });
});

describe("a weekly or monthly bar whose period runs on", () => {
  const bars = (dates: string[], resolution: ManualChartResolution) => historyRows(dates.map((date) => ({ date: new Date(`${date}T00:00:00Z`), close: 100 })), resolution);
  // The status line `history` ends with, from the bars it prints.
  const footer = (rows: ReturnType<typeof bars>, venue: string, now: number) => {
    const forming = formingPeriodBar(rows, venue, now);
    const closedDay = forming ? null : closedPeriodBarDay(rows, venue, now);
    const shown = forming?.rows ?? rows;
    return {
      partial: shown.map((row) => row.partial === true),
      line: formatFreshnessLine(rowsFreshness(shown, {
        ...barHistoryFreshness(rows[0]!.interval), observedKey: "date", oldest: null, cadenceExchange: venue,
        ...(forming ? { periodToDate: forming.periodToDate } : closedDay ? { asOf: closedDay } : {}),
      }, undefined, now)!),
    };
  };
  // Fri 16 Oct 2026 08:14 UTC: New York has not opened; Thursday's session is the latest close.
  const friday = Date.parse("2026-10-16T08:14:00Z");
  const monthly = bars(["2026-09-01", "2026-10-01"], "1mo");
  const weekly = bars(["2026-10-05", "2026-10-12"], "1wk");

  test("is marked partial and dated by the last session it covers, not the start of its period", () => {
    expect(footer(monthly, "NASDAQ", friday)).toEqual({
      partial: [false, true], line: "Source: Gloom Cloud · month to date, through Thu 15 Oct 2026 · not a live feed (monthly bars)",
    });
    expect(footer(weekly, "NASDAQ", friday)).toEqual({
      partial: [false, true], line: "Source: Gloom Cloud · week to date, through Thu 15 Oct 2026 · not a live feed (weekly bars)",
    });
    // While a session trades, the bar runs through today; a coin's always does.
    expect(footer(monthly, "NASDAQ", Date.parse("2026-10-16T15:00:00Z")).line).toContain("month to date, through Fri 16 Oct 2026");
    expect(footer(weekly, "CCC", friday).line).toContain("week to date, through Fri 16 Oct 2026");
    // A venue whose sessions are unknown is read by the calendar, with no day to name.
    expect(footer(monthly, "", friday).line).toContain("· Oct 2026 to date ·");
  });

  test("is complete once the last session of its period has closed, though the month runs on, and dated by that session", () => {
    // Sat 31 Oct: October's last session closed on Friday the 30th, the day its close is from, not the 1st it is dated by.
    const saturday = Date.parse("2026-10-31T12:00:00Z");
    expect(footer(monthly, "NASDAQ", saturday)).toEqual({
      partial: [false, false], line: "Source: Gloom Cloud · Fri 30 Oct 2026 · not a live feed (monthly bars)",
    });
    // Sun 18 Oct: the week of Mon 12 Oct closed on Friday the 16th.
    expect(footer(weekly, "NASDAQ", Date.parse("2026-10-18T05:00:00Z")).line).toBe("Source: Gloom Cloud · Fri 16 Oct 2026 · not a live feed (weekly bars)");
    // A week whose Friday is a holiday ends on Thursday (Good Friday, 3 Apr 2026); a coin's week on Sunday; a venue
    // whose sessions are unknown on the period's last weekday.
    expect(closedPeriodBarDay(bars(["2026-03-30"], "1wk"), "NYSE", Date.parse("2026-04-05T12:00:00Z"))).toBe("2026-04-02");
    expect(closedPeriodBarDay(weekly, "CCC", Date.parse("2026-10-19T05:00:00Z"))).toBe("2026-10-18");
    expect(closedPeriodBarDay(bars(["2026-05-01"], "1mo"), "", Date.parse("2026-06-03T12:00:00Z"))).toBe("2026-05-29");
    expect(closedPeriodBarDay(bars(["2026-10-15", "2026-10-16"], "1d"), "NASDAQ", saturday)).toBeNull();
    // September's bar on 16 Oct, and last week's on Monday before the open, are complete.
    expect(formingPeriodBar(bars(["2026-08-01", "2026-09-01"], "1mo"), "NASDAQ", friday)).toBeNull();
    expect(formingPeriodBar(bars(["2026-10-05"], "1wk"), "NASDAQ", Date.parse("2026-10-12T08:00:00Z"))).toBeNull();
    // Daily bars are left as their source marks them.
    expect(formingPeriodBar(bars(["2026-10-15", "2026-10-16"], "1d"), "NASDAQ", Date.parse("2026-10-16T15:00:00Z"))).toBeNull();
  });

  test("a week that starts on a holiday ends with that calendar week, however its bar is dated", () => {
    // Labor Day week: Monday 7 Sep closed, Friday the 11th its last session. On Saturday the 12th it is complete,
    // dated by its Monday or by its first session, Tuesday the 8th; on Friday morning it still forms.
    const saturday = Date.parse("2026-09-12T12:00:00Z");
    for (const date of ["2026-09-07", "2026-09-08"]) {
      expect(formingPeriodBar(bars(["2026-08-31", date], "1wk"), "NASDAQ", saturday), date).toBeNull();
      expect(formingPeriodBar(bars(["2026-08-31", date], "1wk"), "NASDAQ", Date.parse("2026-09-11T12:00:00Z"))?.periodToDate, date)
        .toEqual({ period: "week", through: "2026-09-10" });
    }
  });
});
