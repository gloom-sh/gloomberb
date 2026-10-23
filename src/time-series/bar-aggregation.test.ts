import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../types/financials";
import { aggregatePriceBars } from "./bar-aggregation";
import { chartBarSizeSource, parseChartBarSize } from "./resolution";
import { DEFAULT_CHART_SPEC, normalizeChartSpec } from "./spec";

const HOUR = 3_600_000;
const iso = (point: PricePoint) => point.date.toISOString();

/** Hourly bars from `start` (UTC), one per entry: [open, high, low, close, volume]. */
function hourly(start: string, rows: Array<[number, number, number, number, number]>, stepMs = HOUR): PricePoint[] {
  const first = Date.parse(start);
  return rows.map(([open, high, low, close, volume], index) => ({ date: new Date(first + index * stepMs), open, high, low, close, volume }));
}

function daily(dates: string[], close = (index: number) => 100 + index): PricePoint[] {
  return dates.map((date, index) => ({ date: new Date(`${date}T00:00:00Z`), open: close(index) - 0.5, high: close(index) + 1, low: close(index) - 1, close: close(index), volume: 10 }));
}

describe("aggregatePriceBars", () => {
  test("4h bars of a US stock start at the 09:30 open, and the session's last one is shorter", () => {
    // 2026-10-16, New York on daylight time: 09:30 is 13:30 UTC, and the last hourly bar opens at 15:30.
    const bars = hourly("2026-10-16T13:30:00Z", [
      [100, 102, 99, 101, 10], [101, 104, 100, 103, 20], [103, 103, 98, 99, 30], [99, 100, 97, 98, 40],
      [98, 99, 96, 97, 50], [97, 101, 97, 100, 60], [100, 100.5, 99.5, 100.2, 70],
    ]);
    const built = aggregatePriceBars(bars, "4h", { symbol: "AAPL", exchange: "NASDAQ" });
    expect(built.map(iso)).toEqual(["2026-10-16T13:30:00.000Z", "2026-10-16T17:30:00.000Z"]);
    expect(built[0]).toMatchObject({ open: 100, high: 104, low: 97, close: 98, volume: 100 });
    expect(built[1]).toMatchObject({ open: 98, high: 101, low: 96, close: 100.2, volume: 180 });
  });

  test("a future's 4h bars follow its 17:00 Chicago session, across the weekend", () => {
    // CME Globex opens 17:00 Central (22:00 UTC in October); hourly bars start on the clock.
    const friday = hourly("2026-10-16T12:00:00Z", Array.from({ length: 9 }, (_, index) => [7800 + index, 7801 + index, 7799 + index, 7800.5 + index, 1000] as [number, number, number, number, number]));
    const sunday = hourly("2026-10-18T22:00:00Z", Array.from({ length: 5 }, (_, index) => [7730 + index, 7731 + index, 7729 + index, 7730.5 + index, 500] as [number, number, number, number, number]));
    const built = aggregatePriceBars([...friday, ...sunday], "4h", { symbol: "ES=F", exchange: "" });
    // Friday's session opened Thursday 22:00 UTC: 22, 02, 06, 10, 14 and 18 UTC. Sunday's opens a new one at 22:00.
    expect(built.map(iso)).toEqual([
      "2026-10-16T10:00:00.000Z", "2026-10-16T14:00:00.000Z", "2026-10-16T18:00:00.000Z",
      "2026-10-18T22:00:00.000Z", "2026-10-19T02:00:00.000Z",
    ]);
    expect(built.map((bar) => bar.volume)).toEqual([2000, 4000, 3000, 2000, 500]);
    expect(built[3]).toMatchObject({ open: 7730, close: 7733.5, high: 7734, low: 7729 });
  });

  test("the forming bar holds the bars so far and stays partial while its last one is", () => {
    const bars = hourly("2026-10-16T13:30:00Z", [[100, 101, 99, 100.5, 10], [100.5, 103, 100, 102, 5]]);
    bars[1] = { ...bars[1]!, partial: true };
    const [forming] = aggregatePriceBars(bars, "4h", { symbol: "AAPL", exchange: "NASDAQ" });
    expect(forming).toMatchObject({ date: new Date("2026-10-16T13:30:00Z"), open: 100, high: 103, low: 99, close: 102, volume: 15, partial: true });
  });

  test("a missing source bar leaves the bar on its place, a missing period leaves no bar, and reported gaps stay gaps", () => {
    const bars = hourly("2026-10-16T13:30:00Z", [[100, 101, 99, 100, 1], [100, 102, 98, 101, 1], [101, 103, 100, 102, 1], [102, 104, 101, 103, 1]]);
    // No 13:30 bar (a halt), and nothing at all in the afternoon bucket.
    const halted = aggregatePriceBars(bars.slice(1), "4h", { symbol: "AAPL", exchange: "NASDAQ" });
    expect(halted.map(iso)).toEqual(["2026-10-16T13:30:00.000Z"]);
    expect(halted[0]).toMatchObject({ open: 100, high: 104, low: 98, close: 103, volume: 3 });
    // The next session's bars do not join the previous session's last bucket.
    const nextDay = hourly("2026-10-19T13:30:00Z", [[103, 104, 102, 103.5, 1]]);
    expect(aggregatePriceBars([...bars, ...nextDay], "2h", { symbol: "AAPL", exchange: "NASDAQ" }).map(iso))
      .toEqual(["2026-10-16T13:30:00.000Z", "2026-10-16T15:30:00.000Z", "2026-10-19T13:30:00.000Z"]);
    const gap = { date: new Date("2026-10-16T17:30:00Z"), close: Number.NaN } as PricePoint;
    const withGap = aggregatePriceBars([...bars, gap], "4h", { symbol: "AAPL", exchange: "NASDAQ" });
    expect(withGap.map(iso)).toEqual(["2026-10-16T13:30:00.000Z", "2026-10-16T17:30:00.000Z"]);
    expect(Number.isNaN(withGap[1]!.close)).toBe(true);
  });

  test("10m bars from 5m bars pair up from the open", () => {
    const fives = hourly("2026-10-16T13:30:00Z", [[1, 2, 0.5, 1.5, 1], [1.5, 3, 1, 2, 2], [2, 2.5, 1.8, 2.2, 3]], 5 * 60_000);
    const built = aggregatePriceBars(fives, "10m", { symbol: "AAPL", exchange: "NASDAQ" });
    expect(built.map(iso)).toEqual(["2026-10-16T13:30:00.000Z", "2026-10-16T13:40:00.000Z"]);
    expect(built[0]).toMatchObject({ open: 1, high: 3, low: 0.5, close: 2, volume: 3 });
  });

  test("2D bars count trading days from 1 January, skip holidays and start again each year", () => {
    // NASDAQ: 1 Jan 2026 and 19 Jan (Martin Luther King Jr. Day) are holidays. Counting from 2 Jan:
    // (2, 5), (6, 7), ... (14, 15), then 16 and 20 Jan pair across the holiday.
    const january = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-14", "2026-01-15", "2026-01-16", "2026-01-20", "2026-01-21"];
    const built = aggregatePriceBars(daily(january), "2d", { symbol: "AAPL", exchange: "NASDAQ" });
    expect(built.map((bar) => bar.date.toISOString().slice(0, 10))).toEqual(["2026-01-02", "2026-01-06", "2026-01-14", "2026-01-16", "2026-01-21"]);
    expect(built[0]).toMatchObject({ open: 99.5, close: 101, high: 102, low: 99, volume: 20 });
    expect(built[3]).toMatchObject({ open: 105.5, close: 107, volume: 20 });
    // 2026 has 251 sessions, so 31 Dec ends the year alone and 4 Jan 2027 starts a new count.
    const yearEnd = ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-04", "2027-01-05"];
    expect(aggregatePriceBars(daily(yearEnd), "2d", { symbol: "AAPL", exchange: "NASDAQ" }).map((bar) => bar.date.toISOString().slice(0, 10)))
      .toEqual(["2026-12-28", "2026-12-29", "2026-12-31", "2027-01-04"]);
  });

  test("a coin's 3D bars count every day, a stock's 3D bars only its trading days", () => {
    const days = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"];
    expect(aggregatePriceBars(daily(days), "3d", { symbol: "BTC-USD", exchange: "CCC" }).map((bar) => bar.date.toISOString().slice(0, 10)))
      .toEqual(["2026-01-01", "2026-01-04"]);
    const sessions = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    expect(aggregatePriceBars(daily(sessions), "3d", { symbol: "ES=F", exchange: "" }).map((bar) => bar.date.toISOString().slice(0, 10)))
      .toEqual(["2026-01-02", "2026-01-07"]);
  });

  test("2W bars count from the year's first Monday and 3mo bars from January", () => {
    const mondays = ["2025-12-29", "2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"];
    expect(aggregatePriceBars(daily(mondays), "2wk", { symbol: "AAPL", exchange: "NASDAQ" }).map((bar) => bar.date.toISOString().slice(0, 10)))
      .toEqual(["2025-12-29", "2026-01-05", "2026-01-19"]);
    const months = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"];
    const quarters = aggregatePriceBars(daily(months), "3mo", { symbol: "AAPL", exchange: "NASDAQ" });
    expect(quarters.map((bar) => bar.date.toISOString().slice(0, 10))).toEqual(["2026-01-01", "2026-04-01"]);
    expect(quarters[0]).toMatchObject({ open: 99.5, close: 102, high: 103, low: 99, volume: 30 });
  });

  test("a source bar whose prices contradict each other leaves its built bar blank", () => {
    const bars = hourly("2026-10-16T13:30:00Z", [[100, 101, 99, 100, 1], [100, 99, 98, 101, 1]]);
    const [built] = aggregatePriceBars(bars, "2h", { symbol: "AAPL", exchange: "NASDAQ" });
    expect(built?.integrity?.sourcePoints).toHaveLength(1);
  });
});

describe("bar sizes", () => {
  test("typed sizes read as the chart stores them", () => {
    expect(["10m", "10 min", "240", "4H", "4 hours", "60m", "2D", "3 days", "2W", "1w", "3mo", "1Y", "1h", "1d"].map(parseChartBarSize))
      .toEqual(["10m", "10m", "4h", "4h", "4h", "1h", "2d", "3d", "2wk", "1wk", "3mo", "12mo", "1h", "1d"]);
    // A capital M alone could be minutes or months; too long or empty bars are not sizes.
    expect(["3M", "25h", "13mo", "0m", "4x", ""].map(parseChartBarSize)).toEqual([null, null, null, null, null, null]);
  });

  test("a built size survives a saved or shared chart, and a stored value that is no size falls back", () => {
    const saved = (resolution: string) => normalizeChartSpec(JSON.parse(JSON.stringify({ ...DEFAULT_CHART_SPEC, viewport: { ...DEFAULT_CHART_SPEC.viewport, resolution } })));
    expect(["4h", "2d", "10m", "3mo"].map((size) => saved(size).viewport.resolution)).toEqual(["4h", "2d", "10m", "3mo"]);
    expect(["240m", "3M", "25h"].map((size) => saved(size).viewport.resolution)).toEqual(Array(3).fill(DEFAULT_CHART_SPEC.viewport.resolution));
  });

  test("a size is built from the longest source bars that divide it and that the source serves", () => {
    expect(chartBarSizeSource("4h")).toBe("1h");
    expect(chartBarSizeSource("10m")).toBe("5m");
    expect(chartBarSizeSource("90m")).toBe("45m");
    expect(chartBarSizeSource("90m", [{ resolution: "30m", maxRange: "6M" }, { resolution: "1h", maxRange: "1Y" }])).toBe("30m");
    expect(chartBarSizeSource("3d")).toBe("1d");
    expect(chartBarSizeSource("2wk")).toBe("1wk");
    // A future whose session opens at 04:15 needs bars that start on its open.
    expect(chartBarSizeSource("2h", [], 4 * 60 + 15)).toBe("15m");
  });
});
