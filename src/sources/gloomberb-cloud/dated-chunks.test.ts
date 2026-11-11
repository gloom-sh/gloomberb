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
function serveCapped(failBefore?: string) {
  const asked: string[] = [];
  apiClient.getCloudHistory = async (_symbol, _exchange, params) => {
    const from = params!.startDate!.slice(0, 10);
    const to = params!.endDate!.slice(0, 10);
    asked.push(`${from}..${to}`);
    if (failBefore && to <= failBefore) throw new Error("socket hang up");
    const bars = WEEKDAYS.filter((time) => day(time) >= from && day(time) <= to).slice(-5_000)
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
  // Newest first, each chunk ending where the next one starts, stopping at the chunk the bars begin in.
  expect(asked.length).toBe(5);
  expect(asked[0]!.endsWith("2026-11-11")).toBe(true);

  serveCapped("1995-01-01");
  const cut = await new GloomberbCloudProvider().getDetailedPriceHistoryWithMetadata("KO", "NYSE", new Date("1960-01-01"), new Date(LAST + DAY_MS), "1d");
  expect(cut.truncatedBefore).toBeDefined();
  expect(day(cut.points[0]!.date.getTime()) >= cut.truncatedBefore!).toBe(true);
  expect(cut.points.length).toBeLessThan(WEEKDAYS.length);
});
