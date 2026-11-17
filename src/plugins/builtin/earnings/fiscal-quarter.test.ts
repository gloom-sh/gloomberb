import { expect, test } from "bun:test";
import { fiscalQuarterInYear, fiscalQuarterOf, fiscalQuarterText, fiscalYearText, placedPeriod } from "./fiscal-quarter";

// NVIDIA names its fiscal years for the January they end in.
const nvidia = { fiscalPeriod: "2026-07", fiscalYear: 2027, fiscalQuarter: 2 };

test("a quarter steps from the one the company's calls name, across fiscal years and a month's drift", () => {
  const label = (period: string) => fiscalQuarterText(fiscalQuarterOf(period, nvidia));
  expect(["2026-10", "2027-01", "2027-04", "2026-01", "2025-10"].map(label)).toEqual([
    "Q3 FY2027", "Q4 FY2027", "Q1 FY2028", "Q4 FY2026", "Q3 FY2026",
  ]);
  // A 52 or 53 week quarter can end in the month after its usual one.
  expect(label("2026-11")).toBe("Q3 FY2027");
  expect(fiscalQuarterText(fiscalQuarterOf("2026-10", nvidia), true)).toBe("Q3 FY27");
  expect(fiscalQuarterOf("2026-10", null)).toBeNull();
  expect(fiscalQuarterOf("October", nvidia)).toBeNull();
});

test("a report without a quarter is placed in the last on the company's cycle 5 to 100 days before it", () => {
  // Apple's quarters end in March, June, September and December.
  const apple = { fiscalPeriod: "2026-09", fiscalYear: 2026, fiscalQuarter: 4 };
  expect(placedPeriod("2027-01-28", apple)).toBe("2026-12");
  // December 31 is only 4 days before January 4: the September quarter, 96 days before.
  expect(placedPeriod("2027-01-04", apple)).toBe("2026-09");
  expect(placedPeriod("2027-01-05", apple)).toBe("2026-12");
  // Micron's quarters end in February, May, August and November.
  expect(placedPeriod("2027-01-28", { ...apple, fiscalPeriod: "2026-08" })).toBe("2026-11");
  expect(placedPeriod("2027-01-28", null)).toBeNull();
});

test("without calls, a quarter is named on the fiscal year its annual statements end, as ERN's calls would name it", () => {
  const label = (period: string, yearEnd: number) => fiscalQuarterText(fiscalQuarterInYear(period, yearEnd));
  // Visa's year ends in September, NVIDIA's in January (its 52/53-week 2026-01-25), a calendar-year company's in December.
  expect([label("2026-12", 9), label("2026-09-30", 9), label("2026-10", 1), label("2026-01-25", 1), label("2026-06-30", 12)])
    .toEqual(["Q1 FY2027", "Q4 FY2026", "Q3 FY2027", "Q4 FY2026", "Q2 FY2026"]);
  // A period ending in a month's first week closes the month before; one off the year's quarters, or with no year end, has none.
  expect(label("2026-02-01", 1)).toBe("Q4 FY2026");
  expect([fiscalQuarterInYear("2026-11", 9), fiscalQuarterInYear("2026-12", null)]).toEqual([null, null]);
  expect([fiscalYearText("2027-09-30", 9), fiscalYearText("2026-12-31", 9)]).toEqual(["FY2027", null]);
});
