import { expect, test } from "bun:test";
import type { PricePoint, Quote } from "../../types/financials";
import { followLiveSparklinePrice } from "./model";

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
