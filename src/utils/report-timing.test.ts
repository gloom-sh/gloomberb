import { expect, test } from "bun:test";
import { localReportTiming } from "./report-timing";

// With the timezone set to Asia/Singapore, `earnings OXY` said only AMC for Monday 9 Nov.
test("a report's timing reads on the reader's clock, on the day it falls there", () => {
  expect(localReportTiming("2026-11-09", "amc", "Asia/Singapore")).toBe("after close, about 05:05 SGT Tue 10 Nov");
  // New York is on summer time in July: the open is 21:30 in Singapore the same day.
  expect(localReportTiming("2026-07-14", "bmo", "Asia/Singapore")).toBe("before open, by 21:30 SGT Tue 14 Jul");
  expect(localReportTiming("2026-11-09", "dmh", "Europe/London")).toBe("during market hours, 14:30 to 21:00 GMT Mon 9 Nov");
  // A reader on New York's clock, or with no zone or no timing, reads the label alone.
  expect(localReportTiming("2026-11-09", "amc", "America/New_York")).toBeNull();
  expect(localReportTiming("2026-11-09", "amc", null)).toBeNull();
  expect(localReportTiming("2026-11-09", null, "Asia/Singapore")).toBeNull();
});

// Berkshire posts its results on a Saturday at about 7:00 a.m. Central: no session places it.
test("a time the company announced is that time, a weekend's included; a weekend date without one is not guessed", () => {
  const berkshire = "2026-11-07T13:00:00.000Z";
  expect(localReportTiming("2026-11-07", "bmo", "Asia/Singapore", berkshire)).toBe("at 21:00 SGT Sat 7 Nov");
  expect(localReportTiming("2026-11-07", "bmo", "America/New_York", berkshire)).toBe("at 08:00 ET Sat 7 Nov");
  expect(localReportTiming("2026-11-07", "bmo", null, berkshire)).toBe("at 13:00 UTC Sat 7 Nov");
  expect(localReportTiming("2026-11-07", "bmo", "Asia/Singapore")).toBeNull();
});
