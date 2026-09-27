import { expect, test } from "bun:test";
import type { FinancialStatement } from "../../../../types/financials";
import { computeTTM } from "./aggregation";
import { buildFinancialTableModel } from "./model";

const dates = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"];
const filed = ["2025-05-01", "2025-08-01", "2025-11-01", "2026-02-01"];

test("TTM keeps quarter provenance and follows flow, opening, closing and average-share availability", () => {
  const quarters: FinancialStatement[] = dates.map((date, index) => ({
    date, currency: "USD", dateSource: "sec",
    dateEvidence: { startDate: ["2025-01-01", "2025-04-01", "2025-07-01", "2025-10-01"][index]!, filed: filed[index]!, accessionNumber: `controlled-${index}` },
    totalRevenue: (index + 1) * 10, netIncome: 0, basicEps: 0, eps: 0,
    beginningCashPosition: 100 + index * 10, endCashPosition: 110 + index * 10,
    totalAssets: 200 + index, basicShares: 100 - index * 10, availableAt: filed[index],
  }));
  const source = structuredClone(quarters);
  const ttm = computeTTM([...quarters].reverse())!;
  expect(ttm).toMatchObject({ totalRevenue: 100, netIncome: 0, basicEps: 0, eps: 0,
    beginningCashPosition: 100, endCashPosition: 140, totalAssets: 203, basicShares: 85,
    availableAt: "2026-02-01", aggregation: { kind: "trailing-four-quarters", periodEnd: "2025-12-31" } });
  expect(ttm.fieldAvailability).toMatchObject({ totalRevenue: "2026-02-01", netIncome: "2026-02-01",
    basicEps: "2026-02-01", eps: "2026-02-01", basicShares: "2026-02-01",
    beginningCashPosition: "2025-05-01", endCashPosition: "2026-02-01", totalAssets: "2026-02-01" });
  expect(ttm.aggregation!.sourcePeriods.map(({ date, dateEvidence }) => [date, dateEvidence]))
    .toEqual(source.map(({ date, dateEvidence }) => [date, dateEvidence]));
  ttm.aggregation!.sourcePeriods[0]!.dateEvidence!.filed = "changed export";
  expect(quarters).toEqual(source);
});

test("partial field availability cannot borrow row or period filing dates for a TTM field", () => {
  const quarters: FinancialStatement[] = dates.map((date, index) => ({
    date, currency: "USD", totalRevenue: 10, netIncome: 0, totalAssets: 100,
    availableAt: filed[index], fieldAvailability: { totalRevenue: filed[index]! },
  }));
  const ttm = computeTTM(quarters)!;
  expect(ttm).toMatchObject({ totalRevenue: 40, netIncome: 0, totalAssets: 100,
    fieldAvailability: { totalRevenue: "2026-02-01" } });
  expect(ttm.availableAt).toBeUndefined();
  expect(ttm.fieldAvailability?.netIncome).toBeUndefined();
  expect(ttm.fieldAvailability?.totalAssets).toBeUndefined();
  quarters[1]!.fieldAvailability!.totalRevenue = "invalid";
  expect(computeTTM(quarters)!.fieldAvailability?.totalRevenue).toBeUndefined();
});

test("growth needs established monetary units but preserves counts across currency changes", () => {
  const annualStatements: FinancialStatement[] = [
    { date: "2023-12-31", totalRevenue: 100, basicShares: 10, dilutedShares: 12 },
    { date: "2024-12-31", currency: "JPY", totalRevenue: 200, basicShares: 20, dilutedShares: 24 },
    { date: "2025-12-31", currency: "USD", totalRevenue: 300, basicShares: 30, dilutedShares: 36 },
  ];
  const table = buildFinancialTableModel({ annualStatements, quarterlyStatements: [], financialCurrency: "USD" }, { expandAll: true })!;
  expect(table.rows.find(({ summaryKey }) => summaryKey === "totalRevenue")!.cells.map(({ growth }) => growth))
    .toEqual([undefined, undefined, undefined]);
  for (const key of ["basicShares", "dilutedShares"]) {
    expect(table.rows.find((row) => row.key === key)!.cells.map(({ growth }) => growth)).toEqual([0.5, 1, undefined]);
  }
  expect(table.rows.find(({ summaryKey }) => summaryKey === "totalRevenue")!.cells.map(({ value }) => value)).toEqual([300, 200, 100]);
});

test("an uncontradicted reporting currency supports known zero and loss comparisons without quote currency", () => {
  const table = buildFinancialTableModel({ financialCurrency: "GBP", annualStatements: [
    { date: "2024-12-31", totalRevenue: 100, netIncome: -10, basicEps: 1, eps: 0.8 },
    { date: "2025-12-31", totalRevenue: 0, netIncome: 0, basicEps: 0, eps: 0 },
  ], quarterlyStatements: [] }, { expandAll: true })!;
  expect(table.rows.find(({ summaryKey }) => summaryKey === "totalRevenue")!.cells[0]).toMatchObject({ value: 0, growth: -1 });
  expect(table.rows.find(({ summaryKey }) => summaryKey === "netIncome")!.cells[0]).toMatchObject({ value: 0, growth: 1 });
  expect(table.rows.find(({ key }) => key === "basicEps")!.cells[0]).toMatchObject({ value: 0, growth: -1 });
  expect(table.rows.find(({ key }) => key === "eps")!.cells[0]).toMatchObject({ value: 0, growth: -1 });
});

test("TTM share growth survives different currency windows while monetary growth stays unavailable", () => {
  const quarterlyStatements: FinancialStatement[] = ["2024", "2025"].flatMap((year, index) => (
    dates.map((date) => ({ date: year + date.slice(4), currency: index ? "USD" : "JPY", totalRevenue: 100, basicShares: index ? 20 : 10 }))
  ));
  const table = buildFinancialTableModel({ annualStatements: [{ date: "2024-12-31", currency: "USD", totalRevenue: 400 }], quarterlyStatements }, { expandAll: true })!;
  expect(table.statements[0]!.date).toBe("TTM");
  expect(table.rows.find(({ summaryKey }) => summaryKey === "totalRevenue")!.cells[0].growth).toBeUndefined();
  expect(table.rows.find(({ key }) => key === "basicShares")!.cells[0]).toMatchObject({ value: 20, growth: 1 });
});
