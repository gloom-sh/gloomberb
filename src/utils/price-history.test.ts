import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../types/financials";
import { calendarHistoryFetchState, isPriceHistoryStaleForCurrentWindow, normalizePriceHistory, priceHistoryIntervalMs } from "./price-history";

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
    // Yahoo labels BSE bars at the 09:15 IST open, the previous New York date.
    expect(outdated(bars("2026-09-21T03:45:00Z", "2026-09-22T03:45:00Z"), "2026-09-22T21:00:00Z", "2026-09-23T02:00:00Z", { exchange: "" })).toBe(false);
    // KRX is closed for Chuseok 09-24 to 09-26 and publishes no calendar here:
    // one refetch after each weekday close it cannot tell from a session.
    const krx = bars("2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z");
    expect(polls(krx, "2026-09-23T08:00:00Z", "2026-09-24T00:00:00Z", "2026-09-28T00:00:00Z", "KRX")).toBe(2);
    // SSE Golden Week, Thursday 10-01 to Thursday 10-08.
    const sse = bars("2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z");
    expect(polls(sse, "2026-09-30T08:00:00Z", "2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z", "SSE")).toBe(5);
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
});
