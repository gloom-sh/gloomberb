import { describe, expect, test } from "bun:test";
import type { PricePoint, Quote } from "../../types/financials";
import { getPricePointTimestamp } from "../../utils/price-history";
import { followLiveSparklinePrice, resolveSparklineHistory, type SparklineWindow } from "./model";

// Wednesday 2026-09-23, 15:00 UTC: the US regular session.
const NOW = Date.UTC(2026, 8, 23, 15);
const DAY_MS = 86_400_000;
const bars: PricePoint[] = [100, 104, 98, 102].map((close, index) => ({ date: new Date(NOW - (4 - index) * 7 * DAY_MS), close }));

function quote(price: number): Quote {
  return {
    symbol: "X", price, currency: "USD", change: price - 101, changePercent: 0, previousClose: 101,
    lastUpdated: NOW - 1_000, marketState: "REGULAR", listingExchangeName: "NASDAQ",
  };
}

test("the sparkline closes on the live price and keeps its series for moves too small to draw", () => {
  const first = followLiveSparklinePrice(bars, quote(101), { now: NOW });
  expect(first.map((point) => point.close)).toEqual([100, 104, 98, 102, 101]);

  // A sixty-fourth of the 98-104 range is 0.09.
  expect(followLiveSparklinePrice(bars, quote(101.05), { now: NOW, previous: first })).toBe(first);
  expect(followLiveSparklinePrice(bars, quote(101.5), { now: NOW, previous: first }).at(-1)?.close).toBe(101.5);
  // A new extreme rescales the line, and crossing the first close flips its colour.
  expect(followLiveSparklinePrice(bars, quote(104.05), { now: NOW, previous: followLiveSparklinePrice(bars, quote(104), { now: NOW }) }).at(-1)?.close).toBe(104.05);
  expect(followLiveSparklinePrice(bars, quote(99.98), { now: NOW, previous: followLiveSparklinePrice(bars, quote(100.02), { now: NOW }) }).at(-1)?.close).toBe(99.98);
});

/** The window as it was chosen before: every bar tested, whatever the period. */
function resolveByTestingEveryBar(history: PricePoint[], period: SparklineWindow): PricePoint[] {
  const valid = history.filter((point) => Number.isFinite(getPricePointTimestamp(point)));
  const latest = valid.at(-1);
  if (!latest) return [];
  const cutoff = getPricePointTimestamp(latest) - { "1D": 1, "1W": 7, "1M": 30, "1Y": 365, all: Number.POSITIVE_INFINITY }[period] * DAY_MS;
  const window = valid.filter((point) => getPricePointTimestamp(point) >= cutoff);
  return window.length >= 2 ? window : valid.slice(-{ "1D": 2, "1W": 7, "1M": 22, "1Y": 252, all: Number.POSITIVE_INFINITY }[period]);
}

describe("resolveSparklineHistory", () => {
  const weekly = Array.from({ length: 2_400 }, (_, index): PricePoint => ({ date: new Date(NOW - (2_399 - index) * 7 * DAY_MS), close: 100 + (index % 17) }));
  const periods: SparklineWindow[] = ["1D", "1W", "1M", "1Y", "all"];

  test("keeps the same bars as testing each one, from a long series to a lone bar", () => {
    const daily = Array.from({ length: 400 }, (_, index): PricePoint => ({ date: new Date(NOW - (399 - index) * DAY_MS).toISOString(), close: 50 + index }));
    const unusable: PricePoint[] = [
      { date: new Date(Number.NaN), close: 1 },
      ...weekly.slice(-30),
      { date: Number.NaN as unknown as Date, close: 2 },
    ];
    const withGap = [...weekly.slice(-40, -20), { date: "not a date" as unknown as Date, close: 3 }, ...weekly.slice(-20)];
    const series: PricePoint[][] = [weekly, daily, unusable, withGap, weekly.slice(-3), weekly.slice(-1), [], [{ date: new Date(Number.NaN), close: 1 }]];

    for (const history of series) {
      for (const period of periods) {
        expect(resolveSparklineHistory(history, period)).toEqual(resolveByTestingEveryBar(history, period));
      }
    }
    // A day holds one weekly bar, too few to draw, so the last two are; a month holds five.
    expect(resolveSparklineHistory(weekly, "1D")).toEqual(weekly.slice(-2));
    expect(resolveSparklineHistory(weekly, "1M")).toEqual(weekly.slice(-5));
  });

  test("reads the end of the series, not all of it", () => {
    let reads = 0;
    const counted = weekly.map((point): PricePoint => ({ close: point.close, get date() { reads += 1; return point.date; } }));
    resolveSparklineHistory(counted, "1M");
    resolveSparklineHistory(counted, "1D");
    // Two thousand bars were read twice a call before.
    expect(reads).toBeLessThan(60);
  });
});
