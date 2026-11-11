import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../api-client";
import { GloomberbCloudProvider } from "./index";

const originalHistory = apiClient.getCloudHistory;
afterEach(() => { apiClient.getCloudHistory = originalHistory; });

const DAY_MS = 86_400_000;
/** Weekday closes from 2 Jan 1970, the listing's first bar, to 10 Nov 2026. */
const FIRST = Date.UTC(1970, 0, 2);
const LAST = Date.UTC(2026, 10, 10);
const WEEKDAYS = Array.from({ length: (LAST - FIRST) / DAY_MS + 1 }, (_, day) => FIRST + day * DAY_MS)
  .filter((time) => new Date(time).getUTCDay() % 6 !== 0);
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The service as it answers: the window's bars, cut to the newest 5,000. */
function serveCapped(failBefore?: string, sessions: readonly number[] = WEEKDAYS) {
  const asked: string[] = [];
  apiClient.getCloudHistory = async (_symbol, _exchange, params) => {
    const from = params!.startDate!.slice(0, 10);
    const to = params!.endDate!.slice(0, 10);
    asked.push(`${from}..${to}`);
    if (failBefore && to <= failBefore) throw new Error("socket hang up");
    const bars = sessions.filter((time) => day(time) >= from && day(time) <= to).slice(-5_000)
      .map((time) => ({ date: day(time), open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    return bars.length > 0 ? { status: "success", data: bars } : { status: "empty", data: null };
  };
  return asked;
}

// A plugin's daily read from 1960 came back as 5,000 bars from 2006-12-27, with no note of the cut.
test("a long window of daily bars is read in chunks back to the first bar, and a chunk that fails says where the bars stop", async () => {
  const asked = serveCapped();
  const provider = new GloomberbCloudProvider();
  const whole = await provider.getDetailedPriceHistoryWithMetadata("KO", "NYSE", new Date("1960-01-01"), new Date(LAST + DAY_MS), "1d");
  expect(whole.points.length).toBe(WEEKDAYS.length);
  expect(day(whole.points[0]!.date.getTime())).toBe("1970-01-02");
  expect(day(whole.points.at(-1)!.date.getTime())).toBe("2026-11-10");
  expect(new Set(whole.points.map((point) => point.date.getTime())).size).toBe(WEEKDAYS.length);
  expect(whole.truncatedBefore).toBeUndefined();
  // Newest first, each chunk ending where the next one starts, stopping at the first chunk with no bar.
  expect(asked.length).toBe(6);
  expect(asked[0]!.endsWith("2026-11-11")).toBe(true);

  serveCapped("1995-01-01");
  const cut = await new GloomberbCloudProvider().getDetailedPriceHistoryWithMetadata("KO", "NYSE", new Date("1960-01-01"), new Date(LAST + DAY_MS), "1d");
  expect(cut.truncatedBefore).toBeDefined();
  expect(day(cut.points[0]!.date.getTime()) >= cut.truncatedBefore!).toBe(true);
  expect(cut.points.length).toBeLessThan(WEEKDAYS.length);
});

// A chunk whose first bar came well after its start stopped the read: a listing suspended for months lost every bar
// before the suspension. A listing delisted more than twelve years before the window ends had no bar in the newest
// chunk, and the read failed.
test("a suspension never cuts a long read, and a listing delisted long ago is read from one request back", async () => {
  // No session from 2008-06 to 2015-06: the chunk from 2002-11 to 2014-11 starts its bars in 2002, the one from
  // 2014-11 in 2015, months after it starts.
  const suspended = WEEKDAYS.filter((time) => day(time) < "2008-06-01" || day(time) >= "2015-06-01");
  serveCapped(undefined, suspended);
  const halted = await new GloomberbCloudProvider().getDetailedPriceHistoryWithMetadata("KO", "NYSE", new Date("1960-01-01"), new Date(LAST + DAY_MS), "1d");
  expect(halted.points.length).toBe(suspended.length);
  expect(day(halted.points[0]!.date.getTime())).toBe("1970-01-02");

  // Traded from 1970 to 1990: more bars than one answer holds.
  const delisted = WEEKDAYS.filter((time) => day(time) <= "1990-06-29");
  const asked = serveCapped(undefined, delisted);
  const old = await new GloomberbCloudProvider().getDetailedPriceHistoryWithMetadata("OLD", "NYSE", new Date("1960-01-01"), new Date(LAST + DAY_MS), "1d");
  expect(old.points.length).toBe(delisted.length);
  expect([day(old.points[0]!.date.getTime()), day(old.points.at(-1)!.date.getTime())]).toEqual(["1970-01-02", "1990-06-29"]);
  expect(old.truncatedBefore).toBeUndefined();
  // The newest chunk, the whole window, then the window's start up to that answer's first bar.
  expect(asked[1]).toBe("1960-01-01..2026-11-11");
  expect(asked.length).toBe(3);
});
