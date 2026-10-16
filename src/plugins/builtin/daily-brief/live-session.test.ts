import { describe, expect, test } from "bun:test";
import { LiveBarAccumulator } from "../../../time-series/live-bars";
import type { PricePoint, Quote } from "../../../types/financials";
import { esTailWindow, foldEsSessionBars } from "./live-session";

const bar = (iso: string, close: number, volume = 1): PricePoint => ({
  date: new Date(iso), open: close, high: close, low: close, close, volume,
});

function quote(iso: string, price: number, overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "ES=F", price, currency: "USD", change: 0, changePercent: 0,
    lastUpdated: Date.parse(iso), listingExchangeName: "CME", marketState: "REGULAR",
    ...overrides,
  };
}

describe("ES session bars", () => {
  test("folds a trade-time print into its five-minute bar", () => {
    const history = [
      bar("2026-10-07T01:40:00.000Z", 7883),
      bar("2026-10-07T01:45:00.000Z", 7881.5),
      bar("2026-10-07T01:45:44.000Z", 7881.75),
    ];
    const points = foldEsSessionBars(history, null, new LiveBarAccumulator(), Date.parse("2026-10-07T01:46:00.000Z"), Date.parse("2026-10-07T01:40:00.000Z"));
    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ date: new Date("2026-10-07T01:45:00.000Z"), close: 7881.75 });
  });

  test("a quote after 20:00 New York moves the forming bar", () => {
    const history = [
      bar("2026-10-07T01:40:00.000Z", 7883),
      bar("2026-10-07T01:45:00.000Z", 7881.5),
    ];
    const bars = new LiveBarAccumulator();
    const next = quote("2026-10-07T01:46:00.000Z", 7800, { marketState: "POSTPOST", postMarketPrice: 7885 });
    const points = foldEsSessionBars(history, next, bars, next.lastUpdated, Date.parse("2026-10-07T01:40:00.000Z"));
    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ date: new Date("2026-10-07T01:45:00.000Z"), close: 7885, high: 7885 });
  });

  test("a quote across the halt opens the new bar and leaves the halt empty", () => {
    const history = [
      bar("2026-10-06T20:50:00.000Z", 7890),
      bar("2026-10-06T20:55:00.000Z", 7892),
    ];
    const bars = new LiveBarAccumulator();
    const next = quote("2026-10-06T22:05:00.000Z", 7870);
    const points = foldEsSessionBars(history, next, bars, next.lastUpdated, Date.parse("2026-10-06T12:00:00.000Z"));
    expect(points.map((point) => point.date.toISOString())).toEqual([
      "2026-10-06T20:50:00.000Z",
      "2026-10-06T20:55:00.000Z",
      "2026-10-06T22:05:00.000Z",
    ]);
    expect(bars.takeReconcileRequest()).toBe(false);
  });

  test("a quote that jumps an unwatched stretch asks for the tail instead of drawing a stub", () => {
    const history = [
      bar("2026-10-06T20:50:00.000Z", 7890),
      bar("2026-10-06T20:55:00.000Z", 7892),
    ];
    const bars = new LiveBarAccumulator();
    const next = quote("2026-10-07T01:19:00.000Z", 7881.75);
    const points = foldEsSessionBars(history, next, bars, next.lastUpdated, next.lastUpdated);
    expect(points).toBe(history);
    expect(bars.takeReconcileRequest()).toBe(true);
  });

  test("the tail refetch starts one bar before the newest and ends on a minute", () => {
    expect(esTailWindow(Date.parse("2026-10-06T20:55:00.000Z"), Date.parse("2026-10-06T22:05:30.000Z"))).toEqual({
      start: Date.parse("2026-10-06T20:50:00.000Z"),
      end: Date.parse("2026-10-06T22:06:00.000Z"),
    });
  });
});
