import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../../types/financials";
import { buildReturnRows } from "./returns-model";
import { buildReturnBars, returnBarTime } from "./returns-chart-model";

const point = (date: string, close: number, extra: Partial<PricePoint> = {}): PricePoint => ({ date: new Date(date), close, ...extra });
const daily = (closes: number[]) => closes.map((close, index) => point(`2026-10-0${index + 1}T00:00:00Z`, close));
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

describe("buildReturnBars", () => {
  test("a bar per row, oldest first, with the figures' best and worst and the newest marked", () => {
    // The first bar is the base: four intervals of +2%, -2.94%, +5.05% and 0%.
    const rows = buildReturnRows(daily([100, 102, 99, 104, 104]), Date.parse("2026-10-01T12:00:00Z"));
    const bars = buildReturnBars(rows, "1d", "NASDAQ");

    expect(bars.bars.map((bar) => day(bar.time))).toEqual(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(bars.bars[0]!.move).toBeCloseTo(0.02, 12);
    expect(day(bars.best!.time)).toBe("2026-10-04");
    expect(day(bars.worst!.time)).toBe("2026-10-03");
    // A flat newest day is still the bar the chart rests on.
    expect(bars.latest).toBe(bars.bars.at(-1)!);
    expect(bars.latest!.move).toBe(0);
    expect(bars.forming).toBe(false);
  });

  test("the newest bar is forming only when it is the row the table marks as still trading", () => {
    const rows = buildReturnRows(daily([100, 101, 103]), Date.parse("2026-10-01T12:00:00Z"));
    expect(buildReturnBars(rows, "1d", "NASDAQ", rows[0]!.key).forming).toBe(true);
    // Any other row marked (a stale key from the window before) does not make it so.
    expect(buildReturnBars(rows, "1d", "NASDAQ", rows[1]!.key).forming).toBe(false);
    expect(buildReturnBars(rows, "1d", "NASDAQ").forming).toBe(false);
  });

  test("a bar with contradictory prices is a gap, and the chart rests on the newest bar with a return", () => {
    // The last bar's close sits above its high, so it has no price and no return.
    const points = [...daily([100, 104, 101]), point("2026-10-04T00:00:00Z", 105, { high: 103, low: 100, open: 101 })];
    const rows = buildReturnRows(points, Date.parse("2026-10-01T12:00:00Z"));
    const bars = buildReturnBars(rows, "1d", "NASDAQ", rows[0]!.key);

    expect(bars.bars.map((bar) => bar.move === null)).toEqual([false, false, true]);
    expect(day(bars.latest!.time)).toBe("2026-10-03");
    // The newest row is the one still trading, but it has no bar to mark.
    expect(bars.forming).toBe(false);
  });

  test("a window with one interval has its bar and no best or worst; an empty one has nothing", () => {
    const one = buildReturnBars(buildReturnRows(daily([100, 101]), Date.parse("2026-10-01T12:00:00Z")), "1d", "NASDAQ");
    expect(one.bars).toHaveLength(1);
    expect(one.latest).toBe(one.bars[0]!);
    expect(one).toMatchObject({ best: null, worst: null, forming: false });

    expect(buildReturnBars([], "1d", "NASDAQ")).toEqual({ bars: [], best: null, worst: null, latest: null, forming: false });
  });
});

describe("returnBarTime", () => {
  test("a daily bar sits on the session day the table dates it by; an intraday bar at its open", () => {
    // A JPX daily bar stamped at 00:00 JST is 15:00 UTC the day before.
    expect(day(returnBarTime(Date.parse("2026-10-01T15:00:00Z"), "1d", "JPX"))).toBe("2026-10-02");
    expect(returnBarTime(Date.parse("2026-10-01T15:00:00Z"), "1h", "JPX")).toBe(Date.parse("2026-10-01T15:00:00Z"));
  });
});
