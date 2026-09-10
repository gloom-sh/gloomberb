import { describe, expect, test } from "bun:test";
import { coalesceFinancialPeriodAliases, mergeFinancialStatementRows } from "./financial-statements";
import { computeTTM } from "../plugins/builtin/ticker-detail/financials/aggregation";
import type { FinancialStatement } from "../types/financials";

test("period evidence follows the selected fiscal date without inventing field availability", () => {
  const dateEvidence = { accessionNumber: "0000909832-26-000050", filed: "2026-06-04", startDate: "2026-02-16" };
  const fiscal: FinancialStatement = { date: "2026-05-10", currency: "USD", dateSource: "sec", dateEvidence, totalRevenue: 70527, netIncome: 2192, totalAssets: 81639 };
  const provider: FinancialStatement = { ...fiscal, date: "2026-05-31", dateSource: "provider", dateEvidence: undefined };
  for (const [primary, fallback] of [[provider, fiscal], [fiscal, provider]] as const) {
    const [merged] = mergeFinancialStatementRows([primary], [fallback]);
    expect(merged).toMatchObject({ date: fiscal.date, dateSource: "sec", dateEvidence });
    expect(merged?.availableAt).toBeUndefined();
    expect(merged?.fieldAvailability).toBeUndefined();
  }
  const sameDate = mergeFinancialStatementRows([{ ...provider, date: fiscal.date }], [fiscal])[0]!;
  expect(sameDate.dateEvidence).toEqual(dateEvidence);
  const different = mergeFinancialStatementRows([{ ...provider, date: "2026-05-09", totalRevenue: 1 }], [{ ...fiscal, availableAt: "2026-06-04" }])[0]!;
  expect(different.date).toBe("2026-05-09");
  expect(different.dateSource).toBe("provider");
  expect(different.dateEvidence).toBeUndefined();
});

describe("mergeFinancialStatementRows", () => {
  test("preserves per-field availability across providers", () => {
    const [merged] = mergeFinancialStatementRows(
      [{
        date: "2025-12-31",
        totalRevenue: 120,
        availableAt: "2026-02-10",
        fieldAvailability: { totalRevenue: "2026-02-10" },
      }],
      [{
        date: "2025-12-31",
        grossProfit: 72,
        availableAt: "2026-02-12",
        fieldAvailability: { grossProfit: "2026-02-12" },
      }],
    );

    expect(merged).toMatchObject({
      availableAt: "2026-02-12",
      totalRevenue: 120,
      grossProfit: 72,
      fieldAvailability: {
        totalRevenue: "2026-02-10",
        grossProfit: "2026-02-12",
      },
    });
  });

  test("never attaches fallback provenance to a different primary value", () => {
    const [merged] = mergeFinancialStatementRows(
      [{
        date: "2025-12-31",
        totalRevenue: 120,
        availableAt: "2026-03-15",
      }],
      [{
        date: "2025-12-31",
        totalRevenue: 100,
        fieldAvailability: { totalRevenue: "2026-02-01" },
      }],
    );

    expect(merged).toMatchObject({
      totalRevenue: 120,
      availableAt: "2026-03-15",
      fieldAvailability: { totalRevenue: "2026-03-15" },
    });
  });

  test("copies fallback availability only when the retained value matches", () => {
    const [matching] = mergeFinancialStatementRows(
      [{ date: "2025-12-31", totalRevenue: 100 }],
      [{
        date: "2025-12-31",
        totalRevenue: 100,
        fieldAvailability: { totalRevenue: "2026-02-01" },
      }],
    );
    const [different] = mergeFinancialStatementRows(
      [{ date: "2025-12-31", totalRevenue: 120 }],
      [{
        date: "2025-12-31",
        totalRevenue: 100,
        fieldAvailability: { totalRevenue: "2026-02-01" },
      }],
    );

    expect(matching?.fieldAvailability?.totalRevenue).toBe("2026-02-01");
    expect(different?.fieldAvailability?.totalRevenue).toBeUndefined();
    expect(different?.availableAt).toBeUndefined();
  });

  test("coalesces calendar-normalized and issuer fiscal period ends", () => {
    const merged = mergeFinancialStatementRows(
      [
        { date: "2025-06-30", totalRevenue: 94_036 },
        { date: "2025-09-30", totalRevenue: 102_466 },
      ],
      [
        {
          date: "2025-06-28",
          totalRevenue: 94_036,
          fieldAvailability: { totalRevenue: "2025-08-01" },
        },
        {
          date: "2025-09-27",
          totalRevenue: 102_466,
          fieldAvailability: { totalRevenue: "2025-10-31" },
        },
      ],
    );

    expect(merged).toEqual([
      {
        date: "2025-06-28",
        availableAt: "2025-08-01",
        totalRevenue: 94_036,
        fieldAvailability: { totalRevenue: "2025-08-01" },
      },
      {
        date: "2025-09-27",
        availableAt: "2025-10-31",
        totalRevenue: 102_466,
        fieldAvailability: { totalRevenue: "2025-10-31" },
      },
    ]);
  });

  test("does not coalesce statement rows outside the fiscal-close tolerance", () => {
    const merged = mergeFinancialStatementRows(
      [{ date: "2025-06-30", totalRevenue: 94_036 }],
      [{
        date: "2025-07-15",
        totalRevenue: 94_036,
        fieldAvailability: { totalRevenue: "2025-08-01" },
      }],
    );

    expect(merged.map((row) => row.date)).toEqual(["2025-06-30", "2025-07-15"]);
  });

  test("retains a primary fiscal close when only the fallback is calendar-normalized", () => {
    const merged = mergeFinancialStatementRows(
      [{
        date: "2025-06-28",
        totalRevenue: 94_036,
        fieldAvailability: { totalRevenue: "2025-08-01" },
      }],
      [{ date: "2025-06-30", totalRevenue: 94_036 }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.date).toBe("2025-06-28");
  });
});


test("does not fill a reporting-currency row from differently denominated statements", () => {
  expect(mergeFinancialStatementRows(
    [{ date: "2025-12-31", currency: "TWD", totalRevenue: 3_800_000_000_000 }],
    [{ date: "2025-12-31", currency: "USD", totalRevenue: 120_000_000_000, netIncome: 60_000_000_000 }],
  )).toEqual([{ date: "2025-12-31", currency: "TWD", totalRevenue: 3_800_000_000_000 }]);
});

test("filing-backed fiscal dates coalesce proven month-end aliases, including older cached duplicates", () => {
  const provider = { date: "2026-05-31", currency: "USD", totalRevenue: 70_527_000_000, netIncome: 2_192_000_000, operatingIncome: 2_815_000_000 };
  const fiscal = { date: "2026-05-10", totalRevenue: provider.totalRevenue, netIncome: provider.netIncome, operatingIncome: provider.operatingIncome, availableAt: "2026-06-04" };
  const [merged] = coalesceFinancialPeriodAliases([provider, fiscal]);
  expect(merged).toMatchObject({ date: "2026-05-10", currency: "USD", availableAt: "2026-06-04" });
  expect(coalesceFinancialPeriodAliases([fiscal, provider])).toEqual([merged!]);
  expect(coalesceFinancialPeriodAliases([merged!, provider, fiscal])).toEqual([merged!]);
  const quarters = coalesceFinancialPeriodAliases([
    { date: "2025-08-31", currency: "USD", totalRevenue: 86_156_000_000 },
    { date: "2025-11-23", currency: "USD", totalRevenue: 67_307_000_000 },
    { date: "2026-02-15", currency: "USD", totalRevenue: 69_597_000_000 },
    provider, fiscal,
  ]);
  expect(computeTTM(quarters)?.totalRevenue).toBe(293_587_000_000);
  for (const distinct of [
    { ...fiscal, netIncome: fiscal.netIncome + 1 },
    { ...fiscal, currency: "CAD" },
    { ...fiscal, date: "2026-06-10" },
    { ...fiscal, availableAt: undefined },
  ]) {
    expect(coalesceFinancialPeriodAliases([provider, distinct])).toHaveLength(2);
  }
});
