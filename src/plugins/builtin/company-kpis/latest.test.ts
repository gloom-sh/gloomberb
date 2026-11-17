import { expect, test } from "bun:test";
import { currentKpiSeries } from "./latest";

const series = (id: string, kind: "year" | "quarter" | "ytd" | "instant", end: string | null) => ({ id, latest: { period: { kind, end } } });

test("Latest lists the series a company still reports: its latest year's and its latest quarters'", () => {
  // HSBC on 17 Nov 2026: quarterly diluted EPS last stated for Q1 2024, beside the 2025 year and the third quarter of 2026.
  const hsbc = [
    series("eps-diluted-quarter", "quarter", "2024-03-31"),
    series("eps-basic-quarter", "quarter", "2026-03-31"),
    series("eps-diluted-year", "year", "2025-12-31"),
    series("revenue-growth-wealth-year", "year", "2024-12-31"),
    series("revenue-quarter", "quarter", "2026-09-30"),
    series("cet1", "instant", "2026-06-30"),
    series("nii-ytd", "ytd", "2025-09-30"),
    series("undated", "quarter", null),
  ];
  expect(currentKpiSeries(hsbc).map((row) => row.id)).toEqual([
    "eps-basic-quarter", "eps-diluted-year", "revenue-quarter", "cet1", "undated",
  ]);
  // A quarter long before the company's latest year is no current quarter; a half within it is (AIA's first half of
  // 2025 beside its 2025 year).
  expect(currentKpiSeries([series("year", "year", "2025-12-31"), series("old-quarter", "quarter", "2023-06-30"),
    series("half", "ytd", "2025-06-30")]).map((row) => row.id)).toEqual(["year", "half"]);
});
