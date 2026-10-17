import { expect, test } from "bun:test";
import { fiscalPeriodLabel, fiscalYearEndMonth, ttmPeriodLabel } from "./fiscal-period";

test("names fiscal periods from the issuer's year end, including 52/53-week calendars", () => {
  // June year end (MSFT): the September quarter opens the next fiscal year.
  expect(fiscalPeriodLabel("2026-06-30", "annual", 6)).toBe("FY2026");
  expect(fiscalPeriodLabel("2026-09-30", "quarterly", 6)).toBe("Q1 FY27");
  expect(fiscalPeriodLabel("2026-03-31", "quarterly", 6)).toBe("Q3 FY26");
  // Late-January year end (NVDA): named for the year it ends in.
  const january = fiscalYearEndMonth([{ date: "2025-01-26" }, { date: "2026-01-25" }]);
  expect(fiscalPeriodLabel("2026-01-25", "annual", january)).toBe("FY2026");
  expect(fiscalPeriodLabel("2025-10-26", "quarterly", january)).toBe("Q3 FY26");
  // A 52/53-week year ending in January's first days belongs to December.
  const december = fiscalYearEndMonth([{ date: "2026-01-03" }]);
  expect(december).toBe(12);
  expect(fiscalPeriodLabel("2026-01-03", "annual", december)).toBe("FY2025");
  expect(fiscalPeriodLabel("2026-04-04", "quarterly", december)).toBe("Q1 FY26");
  // Off the calendar, or with none, the date stays.
  expect(fiscalPeriodLabel("2025-12-31", "annual", 6)).toBe("2025-12-31");
  expect(fiscalPeriodLabel("2026-08-31", "quarterly", 6)).toBe("2026-08-31");
  expect(fiscalPeriodLabel("2026-03-31", "quarterly", null)).toBe("2026-03-31");
  // A trailing twelve months names the quarter it runs to.
  expect(ttmPeriodLabel("2026-03-31", 6)).toBe("TTM Q3 FY26");
  expect(ttmPeriodLabel(undefined, 6)).toBe("TTM");
});
