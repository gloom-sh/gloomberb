import { describe, expect, test } from "bun:test";
import { coalesceFinancialPeriodAliases, filledPeriodsNote, mergeFinancialStatementRows, stalePeriodNote, statementHistoryNotes } from "./financial-statements";
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
  test("merging and JSON roundtrips preserve unknown fields in an authoritative availability map", () => {
    const primary: FinancialStatement = {
      date: "2025-12-31", availableAt: "2026-04-01", totalRevenue: 100, grossProfit: 40,
      fieldAvailability: { grossProfit: "2026-02-01" },
    };
    const fallback: FinancialStatement = { date: primary.date, netIncome: 10, availableAt: "2026-03-01" };
    const merged = JSON.parse(JSON.stringify(mergeFinancialStatementRows([primary], [fallback])[0])) as FinancialStatement;
    expect(merged).toMatchObject({ totalRevenue: 100, grossProfit: 40, netIncome: 10,
      fieldAvailability: { grossProfit: "2026-02-01", netIncome: "2026-03-01" } });
    expect(merged.availableAt).toBeUndefined();
    expect(merged.fieldAvailability?.totalRevenue).toBeUndefined();
    expect(mergeFinancialStatementRows([merged], [fallback])[0]).toEqual(merged);
    // Independent evidence may date a matching retained value, but not a different one.
    const [corroborated] = mergeFinancialStatementRows([merged], [{ date: primary.date, totalRevenue: 100, availableAt: "2026-02-15" }]);
    expect(corroborated?.fieldAvailability?.totalRevenue).toBe("2026-02-15");
    expect(corroborated?.availableAt).toBe("2026-03-01");
    const [emptyMap] = mergeFinancialStatementRows([{ ...primary, fieldAvailability: {} }], [{ date: primary.date }]);
    expect(emptyMap?.fieldAvailability).toEqual({});
    expect(emptyMap?.availableAt).toBeUndefined();
  });

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

describe("statementHistoryNotes", () => {
  test("names the oldest period a report served and how to read further back, from the dates it holds", () => {
    // A trailing-twelve-months column has no date; the oldest year is the oldest period end.
    expect(statementHistoryNotes("annual", ["TTM", "2025-12-31", "2024-12-31", "2023-12-31"], "KO")).toEqual([
      "annual history from 2023; older years not served",
      "earlier years, one metric at a time: gloomberb fn GF KO --period annual --periods 40",
    ]);
    // The year is not a constant: a company with two years served says 2024, and the order of the dates does not matter.
    expect(statementHistoryNotes("annual", ["2024-06-30", "2025-06-30"], "SAN:EPA")[0]).toBe("annual history from 2024; older years not served");
    expect(statementHistoryNotes("quarterly", ["2026-06-30", "2025-03-28"], "KO")).toEqual([
      "quarterly history from 2025-03-28; older quarters not served",
      "earlier quarters, one metric at a time: gloomberb fn GF KO --period quarterly --periods 40",
    ]);
    // A report with no dated period has nothing to say about its history.
    expect(statementHistoryNotes("annual", [], "KO")).toEqual([]);
    expect(statementHistoryNotes("annual", ["TTM"], "KO")).toEqual([]);
  });
});

describe("stalePeriodNote", () => {
  test("says how old a latest period over 15 months old is, from the newest period with the lead figure", () => {
    const now = Date.parse("2026-10-22T02:00:00Z");
    // EVN:ASX's balance sheet stopped at 2024-06-30.
    expect(stalePeriodNote([{ date: "2024-06-30", lead: true }, { date: "2023-06-30", lead: true }], now))
      .toBe("Latest period 2024-06-30 is 27 months old.");
    // Its income statement has a FY2025 column with EPS alone: the latest full period is FY2024's.
    expect(stalePeriodNote([{ date: "TTM", lead: true }, { date: "2025-06-30", lead: false }, { date: "2024-06-30", lead: true }], now))
      .toBe("Latest period 2024-06-30 is 27 months old; 2025-06-30 has only some figures.");
    // 15 months to the day is not over 15 months; a day more is.
    expect(stalePeriodNote([{ date: "2025-07-22", lead: true }], now)).toBeNull();
    expect(stalePeriodNote([{ date: "2025-07-21", lead: true }], now)).toBe("Latest period 2025-07-21 is 15 months old.");
    expect(stalePeriodNote([{ date: "2026-06-30", lead: true }], now)).toBeNull();
    // No dated column, or none with the lead figure: the newest period stands.
    expect(stalePeriodNote([{ date: "TTM", lead: true }], now)).toBeNull();
    expect(stalePeriodNote([{ date: "2024-12-31", lead: false }], now)).toBe("Latest period 2024-12-31 is 21 months old.");
  });
});

describe("filled years", () => {
  const filledFrom = { source: "asx" as const, page: "https://www.asx.com.au/markets/company/EVN", retrievedAt: "2026-10-22T01:00:00.000Z", fields: ["totalRevenue" as const, "netIncome" as const] };
  test("a merged row names only the filled lines it still holds as filled", () => {
    const filled: FinancialStatement = { date: "2025-06-30", currency: "AUD", totalRevenue: 4.351e9, netIncome: 9.26e8, filledFrom };
    // Another source's own revenue for the year wins and is its own; the filled net income stays filled.
    const [merged] = mergeFinancialStatementRows([{ date: "2025-06-30", currency: "AUD", totalRevenue: 4.4e9, eps: 0.46 }], [filled]);
    expect(merged).toMatchObject({ totalRevenue: 4.4e9, netIncome: 9.26e8, eps: 0.46, filledFrom: { ...filledFrom, fields: ["netIncome"] } });
    const [replaced] = mergeFinancialStatementRows([{ date: "2025-06-30", currency: "AUD", totalRevenue: 4.4e9, netIncome: 9.3e8 }], [filled]);
    expect(replaced).not.toHaveProperty("filledFrom");
    expect(filledPeriodsNote([replaced!])).toBeNull();
    expect(filledPeriodsNote([merged!], new Set(["totalAssets"]))).toBeNull();
    expect(filledPeriodsNote([merged!])).toBe("From ASX key statistics (read 2026-10-22): 2025-06-30 net income.");
  });
});
