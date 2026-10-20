import { expect, test } from "bun:test";
import { yearToDateBaseDay, yearToDateBaseLabel, yearToDateStartIndex } from "./year-to-date";

test("YTD is measured from the venue's last close of the prior year, a Friday when 31 Dec is a weekend", () => {
  const now = Date.parse("2026-10-20T16:00:00Z");
  expect(yearToDateBaseDay("2026-10-20", "NYSE", now)).toBe("2025-12-31");
  expect(yearToDateBaseLabel("2026-10-20", "NYSE", now)).toBe("31 Dec");
  // 31 Dec 2022 was a Saturday.
  expect(yearToDateBaseDay("2023-03-01", "NYSE", now)).toBe("2022-12-30");
  expect(yearToDateBaseLabel("2023-03-01", undefined, now)).toBe("30 Dec");
});

test("a YTD run of bars starts at the last one on or before 31 Dec, not at 2 Jan", () => {
  expect(yearToDateStartIndex(["2025-12-29", "2025-12-30", "2025-12-31", "2026-01-02", "2026-10-16"])).toBe(2);
  // Weekly bars dated by their Monday: the week of 29 Dec closes on 2 Jan, so the run starts a week earlier.
  expect(yearToDateStartIndex(["2025-12-22", "2025-12-29", "2026-01-05"], "1wk")).toBe(0);
  expect(yearToDateStartIndex(["2025-11-01", "2025-12-01", "2026-01-01"], "1mo")).toBe(1);
  expect(yearToDateStartIndex(["2026-03-05", "2026-03-06"])).toBe(0);
  expect(yearToDateStartIndex([])).toBe(-1);
});
