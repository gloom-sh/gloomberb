import { describe, expect, test } from "bun:test";
import { mergeFinancialStatementRows } from "./financial-statements";

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
