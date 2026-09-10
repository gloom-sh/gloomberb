import { describe, expect, test } from "bun:test";
import { isPriceHistoryStaleForCurrentWindow, normalizePriceHistory, priceHistoryIntervalMs } from "./price-history";

describe("history freshness follows bar cadence", () => {
  const now = Date.parse("2026-09-10T19:39:09Z");
  const points = (dates: string[]) => dates.map((date) => ({ date: new Date(date), close: 709 }));

  test("allows delayed completed bars without relaxing one-minute freshness", () => {
    const history = points(["2026-09-10T18:45:00Z", "2026-09-10T19:00:00Z"]);
    expect(isPriceHistoryStaleForCurrentWindow(history, now, { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("15m") })).toBe(false);
    expect(isPriceHistoryStaleForCurrentWindow(history, now, { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("1m") })).toBe(true);
    expect(isPriceHistoryStaleForCurrentWindow(history, now, { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("5min") })).toBe(true);
    expect(isPriceHistoryStaleForCurrentWindow(history, Date.parse("2026-09-10T19:46:00Z"), { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("15m") })).toBe(true);
    expect(isPriceHistoryStaleForCurrentWindow(points(["2026-09-10T17:30:00Z"]), now,
      { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("1h") })).toBe(false);
  });

  test("infers generic daily history across weekends and holidays, not a sparse intraday pair", () => {
    const daily = points(["2026-09-04T00:00:00Z", "2026-09-08T00:00:00Z", "2026-09-09T00:00:00Z"]);
    expect(isPriceHistoryStaleForCurrentWindow(daily, now, { exchange: "NASDAQ" })).toBe(false);
    expect(isPriceHistoryStaleForCurrentWindow(daily, now, { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("15m") })).toBe(true);
    const sparse = points(["2026-09-09T19:00:00Z", "2026-09-10T19:00:00Z"]);
    expect(isPriceHistoryStaleForCurrentWindow(sparse, now, { exchange: "NASDAQ" })).toBe(true);
  });

  test("keeps explicit weekly labels usable and still rejects prior-session intraday bars", () => {
    expect(isPriceHistoryStaleForCurrentWindow(points(["2026-09-07T00:00:00Z"]), now,
      { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("1week") })).toBe(false);
    const previousSession = points(["2026-09-09T18:45:00Z", "2026-09-09T19:00:00Z"]);
    expect(isPriceHistoryStaleForCurrentWindow(previousSession, now,
      { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("15min") })).toBe(true);
    expect(isPriceHistoryStaleForCurrentWindow(points(["2026-09-11T19:00:00Z"]), Date.parse("2026-09-13T19:39:09Z"),
      { exchange: "NASDAQ", intervalMs: priceHistoryIntervalMs("15min") })).toBe(false);
  });
});

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
