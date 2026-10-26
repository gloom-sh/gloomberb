import { expect, test } from "bun:test";
import { RANGE_HISTORY_RESOLUTION } from "../../../../time-series/resolution";
import { closedHistoryBarDay, HISTORY_DEFAULT_RANGE, historyBarDate, historyBarSize, historyBarSizeText } from "./history-bars";

const days = (dates: string[]) => dates.map((date) => Date.parse(date));

test("HP opens on a range the source serves in daily bars", () => {
  expect(RANGE_HISTORY_RESOLUTION[HISTORY_DEFAULT_RANGE]).toBe("1d");
});

test("the bar size is read from the usual spacing of the bars, so a holiday's gap leaves daily bars daily", () => {
  expect(historyBarSize(days(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"]))).toBe("1d");
  expect(historyBarSize(days(["2026-09-14", "2026-09-21", "2026-09-28"]))).toBe("1wk");
  expect(historyBarSize(days(["2026-07-01", "2026-08-01", "2026-09-01"]))).toBe("1mo");
  expect(historyBarSize(days(["2026-10-09T13:30:00Z", "2026-10-09T14:30:00Z", "2026-10-09T15:30:00Z"]))).toBe("1h");
  expect(historyBarSize(days(["2026-10-09T13:30:00Z", "2026-10-09T13:35:00Z"]))).toBe("5m");
  expect(historyBarSize(days(["2026-10-09T13:30:00Z", "2026-10-09T13:37:00Z"]))).toBe("intraday");
  // One bar gives no spacing to read.
  expect(historyBarSize(days(["2026-10-09"]))).toBe("1d");
  expect(historyBarSizeText("1wk")).toBe("weekly bars");
  expect(historyBarSizeText("5m")).toBe("5-minute bars");
  expect(historyBarSizeText("intraday")).toBe("intraday bars");
});

test("a month reads as the month, and a week or month still running as to date", () => {
  expect(historyBarDate("2026-09-01", "1mo")).toBe("2026-09");
  expect(historyBarDate("2026-10-01", "1mo", true)).toBe("2026-10 MTD");
  expect(historyBarDate("2026-10-12", "1wk", true)).toBe("2026-10-12 WTD");
  expect(historyBarDate("2026-10-12", "1d")).toBe("2026-10-12");
});

test("a closed daily bar is dated by its day, never its midnight; the session still trading is not closed", () => {
  // Fri 23 Oct 2026: NYSE trades 13:30-20:00 UTC.
  const trading = Date.parse("2026-10-23T15:45:00Z");
  const closed = Date.parse("2026-10-23T22:50:00Z");
  expect(closedHistoryBarDay("1d", "2026-10-23T00:00:00.000Z", "NYSE", trading)).toBeNull();
  expect(closedHistoryBarDay("1d", "2026-10-22T00:00:00.000Z", "NYSE", trading)).toBe("2026-10-22");
  expect(closedHistoryBarDay("1d", "2026-10-23T00:00:00.000Z", "NYSE", closed)).toBe("2026-10-23");
  // A week still running is no closed day; an intraday bar never is.
  expect(closedHistoryBarDay("1wk", "2026-10-19", "NYSE", trading)).toBeNull();
  expect(closedHistoryBarDay("intraday", "2026-10-23T14:30:00Z", "NYSE", closed)).toBeNull();
});
