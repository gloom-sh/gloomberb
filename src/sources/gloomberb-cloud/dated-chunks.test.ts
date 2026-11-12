import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { CloudHistoryParams } from "../../api-client/paths";
import { GloomberbCloudProvider } from "./index";

const originalHistory = apiClient.getCloudHistory;
beforeEach(() => setSystemTime(new Date("2026-11-11T12:00:00Z")));
afterEach(() => {
  apiClient.getCloudHistory = originalHistory;
  setSystemTime();
});

const DAY_MS = 86_400_000;
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
/** Weekday sessions from `first` to 10 Nov 2026. */
function weekdays(first: string, last = "2026-11-10"): number[] {
  const days: number[] = [];
  for (let time = Date.parse(`${first}T00:00:00Z`); time <= Date.parse(`${last}T00:00:00Z`); time += DAY_MS) {
    if (new Date(time).getUTCDay() % 6 !== 0) days.push(time);
  }
  return days;
}
/** A listing's months, from the month of its first session. */
const months = (sessions: readonly number[]) => [...new Set(sessions.map((time) => `${day(time).slice(0, 7)}-01`))];

/**
 * The service as it answers: a dated window's bars cut to the newest 5,000, ALL's newest 600 months, and a window
 * wholly before the first bar failed. Each request is noted as its params, `failTo` failing a dated request that ends
 * on or before that day.
 */
function serve(sessions: readonly number[], failTo?: string) {
  const asked: string[] = [];
  apiClient.getCloudHistory = async (_symbol, _exchange, params: CloudHistoryParams = {}) => {
    const monthly = params.interval === "1month";
    if (!params.startDate) {
      asked.push(`${params.interval} ${params.rangeKey} ${params.outputsize}`);
      const bars = months(sessions).slice(-params.outputsize!);
      return { status: "success", data: bars.map((date) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 })) };
    }
    const from = params.startDate.slice(0, 10);
    const to = params.endDate!.slice(0, 10);
    asked.push(`${params.interval} ${from}..${to}`);
    if (failTo && to <= failTo) throw new Error("socket hang up");
    if (to < day(sessions[0]!)) return { status: "retryable_error", reasonCode: "UPSTREAM_ERROR", data: null };
    const dates = monthly ? months(sessions) : sessions.map(day);
    const bars = dates.filter((date) => date >= from && date <= to).slice(-5_000);
    return bars.length
      ? { status: "success", data: bars.map((date) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 })) }
      : { status: "empty", data: null };
  };
  return asked;
}
const first = (points: Array<{ date: Date }>) => day(points[0]!.date.getTime());

// The ALL window, the ALL count and the newest-chunk-first read each changed what a pane asked for: BT read "price
// history unavailable" offline, the overview lost its ALL chart, and a cold `fn BT AAPL` took 4.1 s against 1.7 s.
test("each read asks first exactly what it asked before, and more only where the answer was cut", async () => {
  const apple = weekdays("1980-12-12");
  const coke = weekdays("1962-01-02");
  const provider = new GloomberbCloudProvider();

  // ALL in months: 600 of them. AAPL's begin after the window: nothing else is asked.
  let asked = serve(apple);
  expect(first((await provider.getPriceHistoryWithMetadata("AAPL", "NASDAQ", "ALL")).points)).toBe("1980-12-01");
  expect(asked).toEqual(["1month ALL 600"]);
  // KO's fill the 600: the months before them are read on back.
  asked = serve(coke);
  const kept = await provider.getPriceHistoryWithMetadata("KO", "NYSE", "ALL");
  expect(first(kept.points)).toBe("1962-01-01");
  expect(kept.points.length).toBe(months(coke).length);
  expect(asked).toEqual(["1month ALL 600", "1month 1901-11-11..1976-12-01"]);

  // ALL in days, as the backtest of ten years asks (newest bars): that one read, cut as it came.
  asked = serve(apple);
  const recent = await provider.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "ALL", "1d", { newestBars: true });
  expect([asked, first(recent.points), recent.points.length]).toEqual([["1day 1976-11-11..2026-11-11"], "2007-09-12", 5_000]);
  // As a plugin asks: ALL's own fifty years first, cut by the bar cap to the newest 5,000; the thirty years before
  // them together; AAPL's bars begin inside them, so nothing more.
  asked = serve(apple);
  const daily = await provider.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "ALL", "1d");
  expect(asked[0]).toBe("1day 1976-11-11..2026-11-11");
  expect(asked.length).toBe(4);
  expect([first(daily.points), daily.points.length]).toEqual(["1980-12-12", apple.length]);
  // KO's begin with the window: read on back, a round of chunks, to where they begin.
  asked = serve(coke);
  const longest = await provider.getPriceHistoryForResolutionWithMetadata("KO", "NYSE", "ALL", "1d");
  // The chunk before 1952 fails, as the service answers a window before the first bar: the bars are whole, not cut.
  expect([first(longest.points), longest.points.length, longest.truncatedBefore]).toEqual(["1962-01-02", coke.length, undefined]);
  expect(asked[0]).toBe("1day 1976-11-11..2026-11-11");
  // Five years of days fit one answer: one request, as before.
  asked = serve(coke);
  await provider.getPriceHistoryForResolutionWithMetadata("KO", "NYSE", "5Y", "1d");
  expect(asked).toEqual(["1day 2021-11-11..2026-11-11"]);

  // A dated window: the window first; daily bars from 1990, cut to 2006, read on back to 1990 together.
  asked = serve(coke);
  const dated = await provider.getDetailedPriceHistoryWithMetadata("KO", "NYSE", new Date("1990-01-01"), new Date("2026-11-11"), "1d");
  expect(asked[0]).toBe("1day 1990-01-01..2026-11-11");
  expect(asked.length).toBe(3);
  expect([first(dated.points), dated.points.length]).toEqual(["1990-01-01", coke.filter((time) => day(time) >= "1990-01-01").length]);
  asked = serve(coke);
  await provider.getDetailedPriceHistoryWithMetadata("KO", "NYSE", new Date("2024-01-01"), new Date("2026-11-11"), "1d");
  expect(asked).toEqual(["1day 2024-01-01..2026-11-11"]);
});

// A chunk whose first bar came well after its start stopped the read: a listing suspended for years lost every bar
// before the suspension.
test("a suspension never cuts a long read, a listing delisted long ago is read whole, and a failed read says where the bars stop", async () => {
  const provider = new GloomberbCloudProvider();
  // No session from 1980 to 2000: a whole twelve-year chunk with no bar, between two with bars.
  const suspended = weekdays("1970-01-02").filter((time) => day(time) < "1980-01-01" || day(time) >= "2000-01-01");
  serve(suspended);
  const halted = await provider.getDetailedPriceHistoryWithMetadata("KO", "NYSE", new Date("1960-01-01"), new Date("2026-11-11"), "1d");
  expect([first(halted.points), halted.points.length]).toEqual(["1970-01-02", suspended.length]);

  // Traded from 1970 to 1990: more bars than one answer holds, all of them read.
  const delisted = weekdays("1970-01-02", "1990-06-29");
  serve(delisted);
  const old = await provider.getDetailedPriceHistoryWithMetadata("OLD", "NYSE", new Date("1960-01-01"), new Date("2026-11-11"), "1d");
  expect([first(old.points), day(old.points.at(-1)!.date.getTime()), old.points.length]).toEqual(["1970-01-02", "1990-06-29", delisted.length]);
  expect(old.truncatedBefore).toBeUndefined();

  // The older reads ending before 1995 fail: the bars, whole, from the day the first of them ends, and that day named.
  const sessions = weekdays("1970-01-02");
  serve(sessions, "1995-01-01");
  const cut = await provider.getDetailedPriceHistoryWithMetadata("KO", "NYSE", new Date("1960-01-01"), new Date("2026-11-11"), "1d");
  expect(cut.truncatedBefore! <= "1995-01-01" && cut.truncatedBefore! > "1980-01-01").toBe(true);
  expect(cut.points.length).toBe(sessions.filter((time) => day(time) >= cut.truncatedBefore!).length);
});
