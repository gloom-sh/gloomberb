import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { createTestTicker } from "../../../test-support/ticker";
import { buildShortWatchRow, customUniverse, oneMonthReturn, ownNamesUniverse, sortShortWatchRows } from "./watch-model";

const close = (date: string, value: number): PricePoint => ({ date: new Date(`${date}T00:00:00Z`), close: value });
/** Weekday closes from `from` to `to`, at `value` unless the day has its own close. */
function daily(from: string, to: string, value: number, closes: Record<string, number> = {}): PricePoint[] {
  const points: PricePoint[] = [];
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day = new Date(day.getTime() + 86_400_000)) {
    const iso = day.toISOString().slice(0, 10);
    if (day.getUTCDay() % 6 !== 0) points.push(close(iso, closes[iso] ?? value));
  }
  return points;
}
const settlement = (date: string, sharesShort: number, shortRatio: number | null = null) => ({
  settlementDate: new Date(`${date}T00:00:00Z`), sharesShort, shortRatio, averageDailyVolume: null, shortPercentFloat: null,
});

describe("oneMonthReturn", () => {
  test("measures from the last close on or before the same day a month earlier, clamped to month end", () => {
    // 31 March less a month is 28 February, not 3 March.
    const history = daily("2026-02-23", "2026-03-31", 1, { "2026-02-27": 100, "2026-03-02": 200, "2026-03-31": 110 });
    expect(oneMonthReturn(history)).toEqual({ percent: expect.closeTo(10, 9), date: "2026-03-31" });
  });

  test("leaves the return unknown on a gap before the base day or on weekly bars", () => {
    expect(oneMonthReturn([close("2026-08-27", 50), ...daily("2026-09-21", "2026-10-02", 60)])).toBeNull();
    const weekly = ["2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02"].map((date) => close(date, 10));
    expect(oneMonthReturn(weekly)).toBeNull();
    // Cached histories carry ISO-string dates.
    const cached = daily("2026-09-01", "2026-10-02", 60, { "2026-09-02": 50 })
      .map((point) => ({ ...point, date: point.date.toISOString() }) as unknown as PricePoint);
    expect(oneMonthReturn(cached)?.percent).toBeCloseTo(20, 9);
  });
});

describe("short watch rows", () => {
  const rising = daily("2026-08-31", "2026-10-02", 13, { "2026-08-31": 10, "2026-09-01": 10, "2026-09-02": 10 });
  const falling = daily("2026-08-31", "2026-10-02", 9, { "2026-08-31": 10, "2026-09-01": 10, "2026-09-02": 10 });
  const row = (symbol: string, sharesShort: number, floatShares: number | null, days: number, history = rising) =>
    buildShortWatchRow({ symbol, records: [settlement("2026-08-29", sharesShort / 2), settlement("2026-09-15", sharesShort, days)], floatShares, history });

  test("crowding counts days to cover only once a twentieth of the float is short", () => {
    expect(row("THIN", 8, 100, 9).setup).toBe("crowded-rising");
    expect(row("MEGA", 1, 100, 9).setup).toBeNull();
    expect(row("NOFLOAT", 1, null, 9, falling).setup).toBe("crowded");
    expect(row("HIGH", 12, 100, 1).changePercent).toBeCloseTo(100, 9);
  });

  test("a float under half the shares short is not used, so days to cover decides alone", () => {
    // BRK.B: 12.53M short against 1.23M, which is Berkshire's Class A float.
    expect(row("BRK.B", 12.53, 1.234, 3.3)).toMatchObject({ percentFloat: null, setup: null });
    expect(row("BRK.B", 12.53, 1.234, 6)).toMatchObject({ percentFloat: null, setup: "crowded-rising" });
    expect(row("FULL", 100, 100, 1).percentFloat).toBe(100);
    // Shares lent twice can put short interest above the float, as the overview reads it too.
    expect(row("SQUEEZE", 140, 100, 1).percentFloat).toBe(140);
  });

  test("the statistics' percent of float of the same settlement is the one shown", () => {
    // GLO-760, GME on 2026-10-13: 42.67M short. The statistics divide by the float capped at the 449.1M shares
    // outstanding (9.50%); the snapshot of an older app build carried the 461.24M float (9.25%).
    const records = [settlement("2026-09-15", 39_069_126, 4.29), settlement("2026-09-30", 42_673_721, 3.98)];
    const gme = (statistics: { settlementDate: string; shortPercentOfFloat: number | null }) =>
      buildShortWatchRow({ symbol: "GME", records, floatShares: 461_240_030, statistics, history: rising });
    expect(gme({ settlementDate: "2026-09-30", shortPercentOfFloat: 42_673_721 / 449_100_000 }))
      .toMatchObject({ percentFloat: expect.closeTo(9.502, 3), daysToCover: 3.98 });
    // Statistics of another settlement are not mixed in: the settlement over the snapshot's float.
    expect(gme({ settlementDate: "2026-09-15", shortPercentOfFloat: 0.087 }).percentFloat).toBeCloseTo(9.252, 3);
    // The same settlement without a percent (no float served) has none.
    expect(gme({ settlementDate: "2026-09-30", shortPercentOfFloat: null }).percentFloat).toBeNull();
  });

  test("ranks crowded names that are rising first, then crowded, then the rest, unreported last", () => {
    const rows = [
      buildShortWatchRow({ symbol: "NONE", records: [], floatShares: 100, history: rising }),
      row("CALM", 2, 100, 1),
      row("DOWN", 40, 100, 2, falling),
      row("UP_LOW", 12, 100, 2),
      row("UP_HIGH", 30, 100, 2),
    ];
    expect(sortShortWatchRows(rows, "setup", "desc").map((entry) => entry.symbol))
      .toEqual(["UP_HIGH", "UP_LOW", "DOWN", "CALM", "NONE"]);
  });
});

describe("short watch names", () => {
  test("a pasted list reads one name per entry, whatever the separators, quote marks and share class spelling", () => {
    expect(customUniverse("GME, amc,CVNA ,BRK-B ")).toEqual({ symbols: ["GME", "AMC", "CVNA", "BRK.B"], notice: null });
    expect(customUniverse("GME;AMC").symbols).toEqual(["GME", "AMC"]);
    expect(customUniverse(`"GME", 'AMC'; “CVNA”, $BF-B\nBF.B\tbrk.b; BRK-B`).symbols).toEqual(["GME", "AMC", "CVNA", "BF.B", "BRK.B"]);
  });

  test("a name left out is listed with its own reason, never only counted", () => {
    // BTC-USD and BRK-B-NONSENSE are not class shares: the dash only reads as a dot after one to five letters and one class letter.
    expect(customUniverse("GME BTC-USD SAN:EPA BRK-B-nonsense 7203.T")).toEqual({
      symbols: ["GME"],
      notice: "Left out: BTC-USD: not a US ticker symbol; SAN:EPA: not US-listed; BRK-B-NONSENSE: not a US ticker symbol; 7203.T: not a US ticker symbol.",
    });
    expect(customUniverse("")).toEqual({ symbols: [], notice: null });
  });

  test("your own names name each one left out, by what is wrong with it", () => {
    const own = { portfolios: ["main"] };
    const universe = ownNamesUniverse([
      createTestTicker("UPST", "Upstart", own),
      createTestTicker("SAN", "Sanofi", { ...own, exchange: "EPA", currency: "EUR" }),
      createTestTicker("BTC-USD", "Bitcoin", { ...own, assetCategory: "CRYPTO" }),
      createTestTicker("NOPE", "Not held", { portfolios: [] }),
    ]);
    expect(universe).toEqual({ symbols: ["UPST"], notice: "Left out: BTC-USD: not a US-listed stock or fund; SAN: not US-listed." });
  });
});
