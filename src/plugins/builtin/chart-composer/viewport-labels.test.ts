import { expect, test } from "bun:test";
import { formatChartDateWindow } from "./viewport-labels";

test("a fixed chart window names its session in the exchange's zone", () => {
  const now = new Date("2026-09-23T20:00:00Z");
  expect(formatChartDateWindow({ start: "2026-09-23T13:30:00Z", end: "2026-09-23T20:00:00Z" }, "America/New_York", now))
    .toBe("Sep 23 session");
  // A Sydney session crosses UTC midnight but is still one local day.
  expect(formatChartDateWindow({ start: "2026-09-22T23:00:00Z", end: "2026-09-23T05:00:00Z" }, "Australia/Sydney", now))
    .toBe("Sep 23 session");
  expect(formatChartDateWindow({ start: "2025-12-29T14:30:00Z", end: "2026-01-02T21:00:00Z" }, "America/New_York", now))
    .toBe("Dec 29 2025 to Jan 2 2026");
});
