import { describe, expect, test } from "bun:test";
import type { ChartResolutionSupport } from "../../../../time-series/resolution";
import type { PricePoint } from "../../../../types/financials";
import {
  availableReturnResolutions,
  buildReturnRows,
  effectiveReturnResolution,
  returnLookbackMs,
  returnVisibleFrom,
  returnWindowStart,
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

  test("calendar ranges count back in UTC, clamping to the end of a shorter month", () => {
    const end = Date.parse("2026-03-31T15:00:00Z");
    expect(new Date(returnWindowStart("1M", end)).toISOString()).toBe("2026-02-28T15:00:00.000Z");
    expect(new Date(returnWindowStart("6H", end)).toISOString()).toBe("2026-03-31T09:00:00.000Z");
  });
});
