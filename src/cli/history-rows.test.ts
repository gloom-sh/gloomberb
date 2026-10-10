import { describe, expect, test } from "bun:test";
import { cleanFloat32Price, historyFlagNote, historyNotes, historyPriceDecimals, historyRows, historyUnit } from "./history-rows";
import { pricePointValues } from "../utils/price-history-integrity";

const daily = (bars: number[][]) => historyRows(bars.map(([open, high, low, close], index) => ({
  date: new Date(Date.UTC(2026, 0, index + 1)), open, high, low, close: close!,
})), "1d");

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

  test("prices are in the quote's currency, an FX pair's counter currency, or index points, and never a guessed one", () => {
    expect(historyUnit("ZAR=X", null)).toEqual({ kind: "pair", currency: "ZAR", unit: "ZAR per USD" });
    expect(historyUnit("EURUSD=X", { currency: "USD" })).toEqual({ kind: "pair", currency: "USD", unit: "USD per EUR" });
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
