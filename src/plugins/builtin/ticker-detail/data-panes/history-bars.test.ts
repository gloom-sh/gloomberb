import { expect, test } from "bun:test";
import { RANGE_HISTORY_RESOLUTION } from "../../../../time-series/resolution";
import { HISTORY_DEFAULT_RANGE, historyBarDate, historyBarSize, historyBarSizeText } from "./history-bars";

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
