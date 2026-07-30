import { describe, expect, test } from "bun:test";
import { isPriceHistoryStaleForCurrentWindow, normalizePriceHistory } from "./price-history";

describe("normalizePriceHistory", () => {
  test("drops poisoned cached history when every timestamp collapses to the same value", () => {
    const history = normalizePriceHistory([
      { date: null as any, close: 101 },
      { date: null as any, close: 102 },
      { date: null as any, close: 103 },
    ]);

    expect(history).toEqual([]);
  });

  test("filters invalid dates and keeps the remaining points in chronological order", () => {
    const history = normalizePriceHistory([
      { date: new Date("2026-03-29T00:00:00Z"), close: 103 },
      { date: null as any, close: 999 },
      { date: new Date("2026-03-27T00:00:00Z"), close: 101 },
      { date: new Date("2026-03-28T00:00:00Z"), close: 102 },
    ]);

    expect(history.map((point) => point.close)).toEqual([101, 102, 103]);
  });

  test("drops zero-price bars instead of treating missing upstream prices as real data", () => {
    const history = normalizePriceHistory([
      { date: new Date("2026-05-13T13:30:00Z"), close: 64 },
      { date: new Date("2026-05-13T13:45:00Z"), close: 0 },
      { date: new Date("2026-05-13T14:00:00Z"), close: Number.NaN },
      { date: new Date("2026-05-13T14:15:00Z"), close: 65 },
    ]);

    expect(history.map((point) => point.close)).toEqual([64, 65]);
  });

  test("repairs extreme zero-volume OHLC fields when adjacent closes stay stable", () => {
    const history = normalizePriceHistory([
      {
        date: new Date("2026-07-29T20:46:00Z"),
        open: 728.4,
        high: 728.7,
        low: 728.3,
        close: 728.5,
        volume: 0,
      },
      {
        date: new Date("2026-07-29T20:47:00Z"),
        open: 686.98,
        high: 728.67,
        low: 686.98,
        close: 728.6,
        volume: 0,
      },
      {
        date: new Date("2026-07-29T20:48:00Z"),
        open: 728.6,
        high: 728.7,
        low: 728.1,
        close: 728.3,
        volume: 0,
      },
    ]);

    expect(history[1]).toEqual({
      date: new Date("2026-07-29T20:47:00Z"),
      open: 728.5,
      high: 728.67,
      low: 728.5,
      close: 728.6,
      volume: 0,
    });
  });

  test("keeps supported zero-volume moves and daily gaps unchanged", () => {
    const volatile = [
      {
        date: new Date("2026-07-29T07:55:00Z"),
        open: 1_000,
        high: 1_005,
        low: 999,
        close: 1_003,
        volume: 0,
      },
      {
        date: new Date("2026-07-29T08:00:00Z"),
        open: 1_003,
        high: 1_075,
        low: 989.74,
        close: 1_070.72,
        volume: 0,
      },
      {
        date: new Date("2026-07-29T08:05:00Z"),
        open: 1_071,
        high: 1_080,
        low: 1_020,
        close: 1_068,
        volume: 0,
      },
    ];
    const daily = [
      { date: new Date("2026-07-27T20:00:00Z"), close: 100, volume: 0 },
      {
        date: new Date("2026-07-28T20:00:00Z"),
        open: 100,
        high: 106,
        low: 99,
        close: 101,
        volume: 0,
      },
      { date: new Date("2026-07-29T20:00:00Z"), close: 102, volume: 0 },
    ];

    expect(normalizePriceHistory(volatile)).toBe(volatile);
    expect(normalizePriceHistory(daily)).toBe(daily);
  });

  test("detects intraday history that is old even when the cache record is fresh", () => {
    expect(
      isPriceHistoryStaleForCurrentWindow(
        [{ date: new Date("2026-04-17T20:00:00Z"), close: 67 }],
        Date.parse("2026-05-13T23:00:00Z"),
      ),
    ).toBe(true);

    expect(
      isPriceHistoryStaleForCurrentWindow(
        [{ date: new Date("2026-05-13T22:45:00Z"), close: 67 }],
        Date.parse("2026-05-13T23:00:00Z"),
      ),
    ).toBe(false);
  });

  test("keeps Friday short-range history usable while the exchange is closed", () => {
    expect(
      isPriceHistoryStaleForCurrentWindow(
        [{ date: new Date("2026-05-15T15:30:00Z"), close: 67 }],
        Date.parse("2026-05-17T12:00:00Z"),
        { exchange: "NASDAQ" },
      ),
    ).toBe(false);
  });

  test("still treats old always-open market history as stale", () => {
    expect(
      isPriceHistoryStaleForCurrentWindow(
        [{ date: new Date("2026-05-15T15:30:00Z"), close: 67 }],
        Date.parse("2026-05-17T12:00:00Z"),
        { exchange: "CCC" },
      ),
    ).toBe(true);
  });
});
