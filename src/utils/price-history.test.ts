import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../types/financials";
import { calendarHistoryFetchState, calendarHistoryLastBarDate, dropLeadingPlaceholderBars, isPriceHistoryStaleForCurrentWindow, normalizePriceHistory, priceHistoryIntervalMs, reachesLatestSettledSession } from "./price-history";

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

  test("retains dated missing closes and explicit zero without advancing freshness on missing values", () => {
    const history = normalizePriceHistory([
      { date: new Date("2026-05-13T13:30:00Z"), close: 64 },
      { date: new Date("2026-05-13T13:45:00Z"), close: 0 },
      { date: new Date("2026-05-13T14:00:00Z"), close: Number.NaN },
      { date: new Date("2026-05-13T14:15:00Z"), close: 65 },
    ]);

    expect(history.map((point) => point.close)).toEqual([64, 0, Number.NaN, 65]);
    expect(normalizePriceHistory([{ date: history[0]!.date, close: -10 }, { date: history[3]!.date, close: 0 }])
      .map((point) => point.close)).toEqual([-10, 0]);
    expect(normalizePriceHistory(history.slice(2, 3))).toEqual(history.slice(2, 3));
    expect(isPriceHistoryStaleForCurrentWindow([history[0]!, { date: history[3]!.date, close: Number.NaN }],
      Date.parse("2026-05-13T14:15:00Z"), { exchange: "NASDAQ", intervalMs: 60_000 })).toBe(true);
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

  test("keeps a non-US venue's session current after its close, until the next open", () => {
    // Tokyo's last bar before the 15:30 closing auction, read that evening in Europe and the next morning.
    const tokyo = [{ date: new Date("2026-10-02T06:24:00Z"), close: 2856.5 }];
    expect(isPriceHistoryStaleForCurrentWindow(tokyo, Date.parse("2026-10-02T18:50:00Z"), { exchange: "JPX", intervalMs: 60_000 })).toBe(false);
    // A copy taken during the session is behind once it has closed.
    expect(isPriceHistoryStaleForCurrentWindow([{ date: new Date("2026-10-02T05:00:00Z"), close: 2860 }],
      Date.parse("2026-10-02T18:50:00Z"), { exchange: "JPX", intervalMs: 60_000 })).toBe(true);
    // In session, an hour without a bar is still behind.
    expect(isPriceHistoryStaleForCurrentWindow([{ date: new Date("2026-10-02T04:00:00Z"), close: 2860 }],
      Date.parse("2026-10-02T05:30:00Z"), { exchange: "JPX", intervalMs: 60_000 })).toBe(true);
    const london = [{ date: new Date("2026-10-02T15:29:00Z"), close: 100 }];
    expect(isPriceHistoryStaleForCurrentWindow(london, Date.parse("2026-10-02T19:00:00Z"), { exchange: "LSE", intervalMs: 60_000 })).toBe(false);
  });

  test("keeps the last session current after the next open until its first delayed bar is due", () => {
    const stale = (date: string, at: string, interval: string) => isPriceHistoryStaleForCurrentWindow(
      [{ date: new Date(date), close: 100 }], Date.parse(at), { exchange: "LSE", intervalMs: priceHistoryIntervalMs(interval) });
    // London opens Friday at 08:00 BST (07:00Z); Thursday's last minute bar was 15:29Z.
    expect(stale("2026-10-01T15:29:00Z", "2026-10-02T07:20:00Z", "1m")).toBe(false);
    expect(stale("2026-10-01T15:29:00Z", "2026-10-02T07:40:00Z", "1m")).toBe(true);
    // The first hourly bar closes at 08:00Z and arrives delayed after it.
    expect(stale("2026-10-01T15:00:00Z", "2026-10-02T08:10:00Z", "1h")).toBe(false);
    // A copy taken earlier in Thursday's session stays behind.
    expect(stale("2026-10-01T10:00:00Z", "2026-10-02T07:20:00Z", "1m")).toBe(true);
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

describe("US history between sessions", () => {
  // Thursday 2026-10-08 closed at 20:00Z (16:00 EDT) and Friday opens at 13:30Z.
  // The last bar of each size opens before the close: 19:59Z, 19:55Z, 19:45Z, and the half-hour 19:30Z for 1h.
  const CLOSE_BARS = { "1m": "19:59", "5m": "19:55", "15m": "19:45", "1h": "19:30" } as const;
  const stale = (last: string, at: string, interval: keyof typeof CLOSE_BARS, options: { exchange?: string; symbol?: string } = {}) =>
    isPriceHistoryStaleForCurrentWindow([{ date: new Date(last), close: 100 }], Date.parse(at),
      { ...options, intervalMs: priceHistoryIntervalMs(interval) });
  // A venue spelled out, a bare symbol, and the index and fund the CLI reports.
  const LISTINGS = [{ exchange: "NASDAQ" }, { exchange: "NYSE" }, {}, { symbol: "SPY" }, { symbol: "^GSPC" }];

  test("the last session answers through the pre-market, weekends and holidays, whatever the bar size or venue spelling", () => {
    for (const listing of LISTINGS) {
      for (const interval of Object.keys(CLOSE_BARS) as Array<keyof typeof CLOSE_BARS>) {
        const thursday = `2026-10-08T${CLOSE_BARS[interval]}:00Z`;
        const friday = `2026-10-09T${CLOSE_BARS[interval]}:00Z`;
        // 04:00 ET, the quiet middle of the pre-market, the hour before the open, and the open itself.
        for (const at of ["2026-10-09T08:00:00Z", "2026-10-09T11:35:00Z", "2026-10-09T13:00:00Z", "2026-10-09T13:30:00Z"]) {
          expect(stale(thursday, at, interval, listing)).toBe(false);
        }
        // Friday's bars on Saturday, Sunday and Monday before the open.
        for (const at of ["2026-10-10T12:00:00Z", "2026-10-11T15:00:00Z", "2026-10-12T11:35:00Z"]) {
          expect(stale(friday, at, interval, listing)).toBe(false);
        }
        // After the close the same day: the post-market sessions.
        for (const at of ["2026-10-08T21:00:00Z", "2026-10-09T00:30:00Z"]) {
          expect(stale(thursday, at, interval, listing)).toBe(false);
        }
      }
    }
  });

  test("a holiday and an early close do not hide the session before them", () => {
    // Thanksgiving 2026-11-26 is closed and the Friday after closes at 13:00 EST (18:00Z).
    const wednesday = "2026-11-25T20:55:00Z";
    for (const at of ["2026-11-26T09:00:00Z", "2026-11-26T15:00:00Z", "2026-11-26T20:30:00Z", "2026-11-27T12:00:00Z", "2026-11-27T14:45:00Z"]) {
      expect(stale(wednesday, at, "5m", { exchange: "NASDAQ" })).toBe(false);
    }
    // Friday's session ends at its early close, not at 16:00.
    const earlyClose = "2026-11-27T17:55:00Z";
    for (const at of ["2026-11-27T19:00:00Z", "2026-11-28T12:00:00Z", "2026-11-30T12:00:00Z", "2026-11-30T14:00:00Z"]) {
      expect(stale(earlyClose, at, "5m", { exchange: "NYSE" })).toBe(false);
    }
    // Wednesday's bars do not cover Friday's session, once its first delayed bar is due.
    expect(stale(wednesday, "2026-11-27T15:01:00Z", "5m", { exchange: "NASDAQ" })).toBe(true);
    expect(stale(earlyClose, "2026-11-30T15:01:00Z", "5m", { exchange: "NASDAQ" })).toBe(true);
  });

  test("the last session answers after the open only until the new session's first delayed bar is due", () => {
    // Allowed lag after the 13:30Z open: 30 minutes for 1m and 5m, 45 for 15m, 2h15 for 1h.
    for (const [interval, lastCurrent, firstStale] of [
      ["1m", "2026-10-09T14:00:00Z", "2026-10-09T14:01:00Z"],
      ["5m", "2026-10-09T14:00:00Z", "2026-10-09T14:01:00Z"],
      ["15m", "2026-10-09T14:15:00Z", "2026-10-09T14:16:00Z"],
      ["1h", "2026-10-09T15:45:00Z", "2026-10-09T15:46:00Z"],
    ] as const) {
      const thursday = `2026-10-08T${CLOSE_BARS[interval]}:00Z`;
      for (const listing of LISTINGS) {
        expect(stale(thursday, lastCurrent, interval, listing)).toBe(false);
        expect(stale(thursday, firstStale, interval, listing)).toBe(true);
      }
    }
  });

  test("a copy that missed a session or stopped short of its close stays behind", () => {
    for (const listing of LISTINGS) {
      // Wednesday's close on Friday's pre-market: Thursday is missing.
      expect(stale("2026-10-07T19:55:00Z", "2026-10-09T11:35:00Z", "5m", listing)).toBe(true);
      expect(stale("2026-10-07T19:55:00Z", "2026-10-09T13:00:00Z", "5m", listing)).toBe(true);
      // Thursday at 10:00 ET, 14:00Z: a copy taken early in the session.
      expect(stale("2026-10-08T14:00:00Z", "2026-10-09T11:35:00Z", "1m", listing)).toBe(true);
      expect(stale("2026-10-08T14:30:00Z", "2026-10-09T11:35:00Z", "1h", listing)).toBe(true);
      expect(stale("2026-10-08T19:20:00Z", "2026-10-09T11:35:00Z", "5m", listing)).toBe(true);
      // Bars from days earlier on a weekend, and Thursday's when Friday's session is missing.
      expect(stale("2026-10-07T19:55:00Z", "2026-10-10T12:00:00Z", "5m", listing)).toBe(true);
      expect(stale("2026-10-08T19:55:00Z", "2026-10-11T15:00:00Z", "5m", listing)).toBe(true);
      // Thursday's bars once Friday trades, and Friday's once Monday does.
      expect(stale("2026-10-08T19:55:00Z", "2026-10-09T15:00:00Z", "5m", listing)).toBe(true);
      expect(stale("2026-10-09T19:55:00Z", "2026-10-12T15:00:00Z", "5m", listing)).toBe(true);
    }
    // The 2026-11-26 holiday does not excuse Tuesday's bars on Friday morning.
    expect(stale("2026-11-24T20:55:00Z", "2026-11-27T12:00:00Z", "5m", { exchange: "NASDAQ" })).toBe(true);
  });
});

describe("TASE history between sessions", () => {
  // Israel is on UTC+3 until 25 October. Monday to Thursday the cash market closes at 17:30 (14:30Z) and
  // Friday at 13:50 (10:50Z). Cloud's last bar of each session opens before the closing auction: 17:09
  // and 13:29 local at 5m, 16:50 and 12:50 at 1h.
  const stale = (last: string, at: string, interval: "5m" | "1h" = "5m") =>
    isPriceHistoryStaleForCurrentWindow([{ date: new Date(last), close: 100 }], Date.parse(at),
      { exchange: "TASE", symbol: "LUMI", intervalMs: priceHistoryIntervalMs(interval) });
  const FRIDAY = { "5m": "2026-10-09T10:29:00Z", "1h": "2026-10-09T09:50:00Z" } as const;
  const THURSDAY = { "5m": "2026-10-08T14:09:00Z", "1h": "2026-10-08T13:50:00Z" } as const;

  test("a complete Friday session answers after its early close, over the weekend and into Monday's open", () => {
    for (const interval of ["5m", "1h"] as const) {
      // 14:30 and 18:09 Friday, Saturday, Sunday, Monday 08:00, and Monday 10:20 before its first delayed bar is due.
      for (const at of ["2026-10-09T11:30:00Z", "2026-10-09T15:09:00Z", "2026-10-10T12:00:00Z", "2026-10-11T12:00:00Z",
        "2026-10-12T05:00:00Z", "2026-10-12T07:20:00Z"]) {
        expect(stale(FRIDAY[interval], at, interval), `${interval} ${at}`).toBe(false);
      }
    }
  });

  test("a Friday copy that stopped at midday is behind once the market closed", () => {
    expect(stale("2026-10-09T09:04:00Z", "2026-10-09T11:30:00Z")).toBe(true);
    expect(stale("2026-10-09T09:04:00Z", "2026-10-09T15:09:00Z")).toBe(true);
    expect(stale("2026-10-09T07:50:00Z", "2026-10-09T15:09:00Z", "1h")).toBe(true);
  });

  test("Monday to Thursday keep the 17:30 close, which Friday's early close does not move", () => {
    for (const interval of ["5m", "1h"] as const) {
      for (const at of ["2026-10-08T15:30:00Z", "2026-10-09T05:00:00Z"]) {
        expect(stale(THURSDAY[interval], at, interval), `${interval} ${at}`).toBe(false);
      }
    }
    // Where a Friday copy would end, a Thursday one has missed the afternoon.
    expect(stale(FRIDAY["5m"].replace("-09T", "-08T"), "2026-10-08T15:30:00Z")).toBe(true);
    expect(stale("2026-10-08T11:00:00Z", "2026-10-08T15:30:00Z")).toBe(true);
  });
});

describe("round-the-clock coin history", () => {
  // 07:29Z on a Friday: the US market closed 11 hours ago and opens in six.
  const now = Date.parse("2026-10-09T07:29:00Z");
  const MIN = 60_000;
  // Bars every `step` minutes up to `last`, with none inside the hole.
  const bars = (last: string, step: number, hole?: [string, string]): PricePoint[] => {
    const end = Date.parse(last);
    const times = Array.from({ length: 200 }, (_, index) => end - (199 - index) * step * MIN)
      .filter((time) => !hole || time <= Date.parse(hole[0]) || time >= Date.parse(hole[1]));
    return times.map((time) => ({ date: new Date(time), close: 85_000 }));
  };
  const stale = (points: PricePoint[], step: number, options: { symbol?: string; exchange?: string }) =>
    isPriceHistoryStaleForCurrentWindow(points, now, { ...options, intervalMs: step * MIN });

  test("a coin is judged by the age of its latest bar, not by the US session, whatever the exchange says", () => {
    const twoHoursOld = bars("2026-10-09T05:15:00Z", 5);
    // Judged as a US listing it reaches the latest close and reads as current.
    expect(stale(twoHoursOld, 5, {})).toBe(false);
    expect(stale(twoHoursOld, 5, { symbol: "BTC-USD" })).toBe(true);
    expect(stale(twoHoursOld, 5, { symbol: "ETH/USD" })).toBe(true);
    expect(stale(twoHoursOld, 5, { symbol: "BTC-USD:CCC" })).toBe(true);
    // The crypto venue's two-hour allowance is not the rule either.
    expect(stale(bars("2026-10-09T06:25:00Z", 5), 5, { exchange: "CCC" })).toBe(true);
    // Two bars and the publishing allowance: 25 minutes at 5m, 2h15 at 1h.
    expect(stale(bars("2026-10-09T07:04:00Z", 5), 5, { symbol: "BTC-USD" })).toBe(false);
    expect(stale(bars("2026-10-09T07:03:00Z", 5), 5, { symbol: "BTC-USD" })).toBe(true);
    expect(stale(bars("2026-10-09T05:14:00Z", 60), 60, { symbol: "BTC-USD" })).toBe(false);
    expect(stale(bars("2026-10-09T05:13:00Z", 60), 60, { symbol: "BTC-USD" })).toBe(true);
    expect(stale(bars("2026-10-08T19:00:00Z", 60), 60, { symbol: "BTC-USD" })).toBe(true);
    expect(stale(bars("2026-10-08T19:00:00Z", 60), 60, { exchange: "CCC" })).toBe(true);
    // A daily series is judged by its cache policy.
    expect(isPriceHistoryStaleForCurrentWindow(bars("2026-10-08T00:00:00Z", 1440), now, { symbol: "BTC-USD", intervalMs: 1440 * MIN })).toBe(false);
  });

  test("a hole of hours in the last six hours is behind, an older one is not", () => {
    expect(stale(bars("2026-10-09T07:25:00Z", 5, ["2026-10-09T03:00:00Z", "2026-10-09T05:30:00Z"]), 5, { symbol: "BTC-USD" })).toBe(true);
    expect(stale(bars("2026-10-09T07:25:00Z", 5, ["2026-10-08T22:00:00Z", "2026-10-09T01:00:00Z"]), 5, { symbol: "BTC-USD" })).toBe(false);
    // Hourly bars tolerate a gap of three bars.
    expect(stale(bars("2026-10-09T06:00:00Z", 60, ["2026-10-09T01:00:00Z", "2026-10-09T04:00:00Z"]), 60, { symbol: "BTC-USD" })).toBe(false);
    expect(stale(bars("2026-10-09T06:00:00Z", 60, ["2026-10-09T01:00:00Z", "2026-10-09T05:00:00Z"]), 60, { symbol: "BTC-USD" })).toBe(true);
  });

  test("other listings keep their own rules: fiat pairs, equities and a bare BTC fund", () => {
    const afterHours = bars("2026-10-09T05:15:00Z", 5);
    expect(stale(afterHours, 5, { symbol: "EUR-USD" })).toBe(false);
    expect(stale(afterHours, 5, { symbol: "BTC" })).toBe(false);
    // Thursday's regular session stays current until the next open.
    expect(stale(bars("2026-10-08T19:55:00Z", 5), 5, { symbol: "AAPL", exchange: "NASDAQ" })).toBe(false);
  });

  test("a bare coin's daily copy is refetched within the hour and a stale server answer never counts as settled", () => {
    const daily = ["2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z"].map((date) => ({ date: new Date(date), close: 85_000 }));
    const state = (symbol: string, fetched: string) => calendarHistoryFetchState(daily, Date.parse(fetched), now, { symbol, intervalMs: 1440 * MIN });
    expect(state("BTC-USD", "2026-10-09T05:00:00Z")).toBe("unsettled");
    expect(state("BTC-USD", "2026-10-09T06:45:00Z")).toBe("current");
    expect(state("AAPL", "2026-10-09T05:00:00Z")).toBe("current");
    expect(reachesLatestSettledSession(daily, now, { symbol: "AAPL", intervalMs: 1440 * MIN })).toBe(true);
    expect(reachesLatestSettledSession(daily, now, { symbol: "BTC-USD", intervalMs: 1440 * MIN })).toBe(false);
  });
});

describe("calendar history fetched copies", () => {
  const DAY = 86_400_000;
  const at = (iso: string) => Date.parse(iso);
  const bars = (...dates: string[]): PricePoint[] => dates.map((date, index) => ({ date: new Date(date), close: 100 + index }));
  // Refetched before it answers: unsettled, or behind and due a re-check.
  const isOutdated = (...args: Parameters<typeof calendarHistoryFetchState>) =>
    ["unsettled", "recheck"].includes(calendarHistoryFetchState(...args));
  const outdated = (points: PricePoint[], fetched: string, now: string, options: Parameters<typeof calendarHistoryFetchState>[3]) =>
    isOutdated(points, at(fetched), at(now), { intervalMs: DAY, ...options });
  // Polls every 10 minutes; each refetch answers the same bars. Counts refetches.
  const polls = (points: PricePoint[], fetched: string, from: string, to: string, exchange: string) => {
    let fetchedAt = at(fetched);
    let count = 0;
    for (let now = at(from); now <= at(to); now += 10 * 60_000) {
      if (!isOutdated(points, fetchedAt, now, { intervalMs: DAY, exchange })) continue;
      fetchedAt = now;
      count++;
    }
    return count;
  };

  test("a US copy missing a settled session is re-checked less often as that close recedes", () => {
    const behind = bars("2026-09-18T00:00:00Z", "2026-09-21T00:00:00Z");
    const current = bars("2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
    const tsla = { exchange: "NASDAQ" };
    // Fetched just after the 09-22 close (20:00 UTC) settled: an hour apart.
    expect(outdated(behind, "2026-09-22T20:31:00Z", "2026-09-22T21:30:00Z", tsla)).toBe(false);
    expect(outdated(behind, "2026-09-22T20:31:00Z", "2026-09-22T21:32:00Z", tsla)).toBe(true);
    // Fetched the next morning: a quarter of the time since that close.
    expect(outdated(behind, "2026-09-23T11:41:00Z", "2026-09-23T16:40:00Z", tsla)).toBe(false);
    expect(outdated(behind, "2026-09-23T11:41:00Z", "2026-09-23T17:00:00Z", tsla)).toBe(true);
    expect(outdated(behind, "2026-09-23T11:41:00Z", "2026-09-23T20:10:00Z", tsla)).toBe(true);
    expect(outdated(behind, "2026-09-23T11:41:00Z", "2026-09-23T17:30:00Z", { ...tsla, checkedAt: at("2026-09-23T16:00:00Z") })).toBe(false);
    expect(calendarHistoryFetchState(behind, at("2026-09-23T11:41:00Z"), at("2026-09-23T12:00:00Z"), { ...tsla, intervalMs: DAY })).toBe("behind");
    expect(outdated(current, "2026-09-23T11:41:00Z", "2026-09-23T18:00:00Z", tsla)).toBe(false);
    // Weekends and published holidays are not missing sessions.
    expect(outdated(bars("2026-09-03T00:00:00Z", "2026-09-04T13:30:00Z"), "2026-09-05T12:00:00Z", "2026-09-07T22:00:00Z", tsla)).toBe(false);
  });

  test("a halted US listing re-checks a handful of times over a weekend", () => {
    const halted = bars("2026-09-16T00:00:00Z", "2026-09-17T00:00:00Z");
    const count = polls(halted, "2026-09-18T20:31:00Z", "2026-09-18T20:31:00Z", "2026-09-21T13:00:00Z", "NYSE");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(15);
  });

  test("weekly and monthly copies are behind only once a later period has a session", () => {
    const weekly = bars("2026-09-07T04:00:00Z", "2026-09-14T04:00:00Z");
    const options = { exchange: "NASDAQ", intervalMs: 7 * DAY };
    expect(outdated(weekly, "2026-09-19T12:00:00Z", "2026-09-20T12:00:00Z", options)).toBe(false);
    // Fetched after Monday's close without the new week.
    expect(outdated(weekly, "2026-09-22T12:00:00Z", "2026-09-22T18:00:00Z", options)).toBe(true);
    const monthly = { ...options, intervalMs: 30 * DAY };
    expect(outdated(bars("2026-08-01T04:00:00Z", "2026-09-01T04:00:00Z"), "2026-09-22T12:00:00Z", "2026-09-22T18:00:00Z", monthly)).toBe(false);
    expect(outdated(bars("2026-07-01T04:00:00Z", "2026-08-01T04:00:00Z"), "2026-09-22T12:00:00Z", "2026-09-22T18:00:00Z", monthly)).toBe(true);
  });

  test("only venues with published closures count a missing session", () => {
    // FX, bare indices and bare listings have no known venue calendar.
    const fx = bars("2026-09-20T23:00:00Z", "2026-09-21T23:00:00Z");
    expect(outdated(fx, "2026-09-22T21:00:00Z", "2026-09-23T02:00:00Z", { exchange: "" })).toBe(false);
    expect(outdated(bars("2026-09-17T00:00:00Z", "2026-09-18T00:00:00Z"), "2026-09-22T21:00:00Z", "2026-09-23T12:00:00Z", { exchange: "" })).toBe(false);
    // The feed labels BSE bars at the 09:15 IST open, the previous New York date.
    expect(outdated(bars("2026-09-21T03:45:00Z", "2026-09-22T03:45:00Z"), "2026-09-22T21:00:00Z", "2026-09-23T02:00:00Z", { exchange: "" })).toBe(false);
    // The JSE is closed for Heritage Day on 09-24 and publishes no calendar here:
    // one refetch after each weekday close, the holiday's included.
    const toWednesday = bars("2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z");
    expect(polls(toWednesday, "2026-09-23T16:00:00Z", "2026-09-24T00:00:00Z", "2026-09-28T00:00:00Z", "JSE")).toBe(2);
    // KRX Chuseok, 09-24 to 09-26, is covered: no missing session before Monday.
    expect(polls(toWednesday, "2026-09-23T08:00:00Z", "2026-09-24T00:00:00Z", "2026-09-28T00:00:00Z", "KRX")).toBe(0);
    // SSE Golden Week, Oct 1-7, is covered: no missing session before Oct 8 opens.
    const sse = bars("2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z");
    expect(polls(sse, "2026-09-30T08:00:00Z", "2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z", "SSE")).toBe(0);
    const btc = bars("2026-09-26T00:00:00Z", "2026-09-27T00:00:00Z");
    expect(outdated(btc, "2026-09-27T10:00:00Z", "2026-09-27T10:45:00Z", { exchange: "CCC" })).toBe(false);
    expect(outdated(btc, "2026-09-27T10:00:00Z", "2026-09-27T11:05:00Z", { exchange: "CCC" })).toBe(true);
  });

  test("other venues close on their own clock and weekdays", () => {
    const lse = { exchange: "LSE" };
    // An in-session copy with today's partial bar. LSE closes 16:30 London
    // (15:30 UTC in summer), and its auction settles by 16:40.
    const partial = bars("2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z");
    expect(outdated(partial, "2026-09-23T11:00:00Z", "2026-09-23T16:05:00Z", lse)).toBe(false);
    expect(outdated(partial, "2026-09-23T11:00:00Z", "2026-09-23T16:15:00Z", lse)).toBe(true);
    // Fetched after the close without that session: maybe a local holiday.
    const behind = bars("2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
    expect(outdated(behind, "2026-09-23T18:00:00Z", "2026-09-23T19:05:00Z", lse)).toBe(false);
    // Friday's copy stays current over the weekend and into Monday's session.
    const friday = bars("2026-09-24T00:00:00Z", "2026-09-25T00:00:00Z");
    expect(outdated(friday, "2026-09-25T17:00:00Z", "2026-09-27T12:00:00Z", lse)).toBe(false);
    expect(outdated(friday, "2026-09-25T17:00:00Z", "2026-09-28T12:00:00Z", lse)).toBe(false);
    // JPX was closed 09-21 to 09-23 in 2026; Friday's bar stays the latest.
    const jpx = bars("2026-09-17T15:00:00Z", "2026-09-18T00:00:00Z");
    expect(outdated(jpx, "2026-09-18T08:00:00Z", "2026-09-23T12:00:00Z", { exchange: "JPX" })).toBe(false);
    expect(outdated(jpx, "2026-09-18T08:00:00Z", "2026-09-24T08:00:00Z", { exchange: "JPX" })).toBe(true);
    // JPX publishes its closures, so a copy fetched after the 09-24 close
    // without that session is behind.
    expect(outdated(jpx, "2026-09-24T07:10:00Z", "2026-09-24T08:20:00Z", { exchange: "JPX" })).toBe(true);
  });

  test("a copy fetched before the close waits after a re-check that did not replace it", () => {
    const partial = bars("2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z");
    const state = (now: string, checkedAt?: string) => calendarHistoryFetchState(partial, at("2026-09-23T17:00:00Z"), at(now),
      { exchange: "NASDAQ", intervalMs: DAY, checkedAt: checkedAt ? at(checkedAt) : undefined });
    expect(state("2026-09-23T20:31:00Z")).toBe("unsettled");
    // A check made before the close settled says nothing about the settled bar.
    expect(state("2026-09-23T20:31:00Z", "2026-09-23T20:20:00Z")).toBe("unsettled");
    expect(state("2026-09-23T20:34:00Z", "2026-09-23T20:31:00Z")).toBe("pending");
    expect(state("2026-09-23T20:36:00Z", "2026-09-23T20:31:00Z")).toBe("unsettled");
  });

  test("the latest bar is dated in the venue's zone, as the fetch state reads it", () => {
    // The feed stamps a JPX daily bar at 00:00 JST, Cloud at UTC midnight.
    expect(calendarHistoryLastBarDate(bars("2026-09-16T15:00:00Z", "2026-09-17T15:00:00Z"), "JPX")).toBe("2026-09-18");
    expect(calendarHistoryLastBarDate(bars("2026-09-17T00:00:00Z", "2026-09-18T00:00:00Z"), "JPX")).toBe("2026-09-18");
    expect(calendarHistoryLastBarDate(bars("2026-09-21T04:00:00Z", "2026-09-22T04:00:00Z"), "")).toBe("2026-09-22");
    expect(calendarHistoryLastBarDate([], "JPX")).toBeNull();
  });
});

describe("leading zero-volume single-price bars", () => {
  // A listing whose source dates the offer price as a bar before the first trade.
  const offer = (date: string): PricePoint => ({ date: new Date(date), open: 31, high: 31, low: 31, close: 31, volume: 0 });
  const traded = (date: string, close: number, volume = 1_000_000): PricePoint =>
    ({ date: new Date(date), open: close - 1, high: close + 1, low: close - 2, close, volume });

  test("drops the offer bar before a listing's first daily and intraday trade", () => {
    const daily = [offer("2025-06-04"), traded("2025-06-05", 83.23), traded("2025-06-06", 107.7)];
    expect(dropLeadingPlaceholderBars(daily)).toEqual(daily.slice(1));
    const intraday = [offer("2025-06-04T13:40:00Z"), traded("2025-06-04T16:35:00Z", 75.9), traded("2025-06-04T16:40:00Z", 88.88)];
    expect(dropLeadingPlaceholderBars(intraday)).toEqual(intraday.slice(1));
    // Repeated reads of one array keep one result, so merged views stay stable.
    expect(dropLeadingPlaceholderBars(daily)).toBe(dropLeadingPlaceholderBars(daily));
  });

  test("keeps series without volume, quiet bars after the first trade and ordinary stocks", () => {
    const index = [offer("2026-09-01"), offer("2026-09-02"), { ...offer("2026-09-03"), close: 32, high: 32 }];
    expect(dropLeadingPlaceholderBars(index)).toBe(index);
    const unreported = index.map(({ volume: _volume, ...point }) => point);
    expect(dropLeadingPlaceholderBars(unreported)).toBe(unreported);
    const stock = [traded("2026-09-01", 50), offer("2026-09-02"), traded("2026-09-03", 51)];
    expect(dropLeadingPlaceholderBars(stock)).toBe(stock);
    const quietOpen = [{ ...traded("2026-09-01", 50), volume: 0 }, traded("2026-09-02", 51)];
    expect(dropLeadingPlaceholderBars(quietOpen)).toBe(quietOpen);
  });

  test("keeps an index whose early decades carry no volume", () => {
    // Long-lived index daily history: single-price bars without volume for
    // decades, then volume reporting begins. Those bars are real closes.
    const daily = [offer("1927-12-30"), offer("1928-01-03"), offer("1949-12-30"), { ...offer("1950-01-03"), volume: 1_260_000 }];
    expect(dropLeadingPlaceholderBars(daily)).toBe(daily);
    // Its weekly series starts with a one-day week, then ranged weeks still without volume.
    const weekly = [offer("1927-12-26"), { ...traded("1928-01-02", 17.8), volume: 0 }, traded("1950-01-02", 17.1)];
    expect(dropLeadingPlaceholderBars(weekly)).toBe(weekly);
  });
});
