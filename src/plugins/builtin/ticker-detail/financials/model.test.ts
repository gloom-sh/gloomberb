import { describe, expect, test } from "bun:test";
import type { TickerFinancials } from "../../../../types/financials";
import {
  buildFinancialTableModel,
  computeTTM,
  financialStatementCurrency,
  resolveFinancialPeriodOption,
  resolveFinancialSubTabKey,
} from "./model";

function createFinancials(): TickerFinancials {
  return {
    annualStatements: [
      { date: "2024-12-31", totalRevenue: 100, netIncome: 25 },
      { date: "2025-12-31", totalRevenue: 150, netIncome: 45 },
    ],
    quarterlyStatements: [
      { date: "2025-03-31", totalRevenue: 10, netIncome: 1 },
      { date: "2025-06-30", totalRevenue: 20, netIncome: 2 },
      { date: "2025-09-30", totalRevenue: 30, netIncome: 3 },
      { date: "2025-12-31", totalRevenue: 40, netIncome: 4 },
    ],
    priceHistory: [],
  };
}

describe("financial statement table model", () => {
  test("uses annual rows with a TTM column when quarterly data is available", () => {
    const table = buildFinancialTableModel(createFinancials(), {
      period: "annual",
      statement: "income",
    });

    expect(table?.period).toBe("annual");
    expect(table?.statements.map((statement) => statement.date)).toEqual(["TTM", "2025-12-31", "2024-12-31"]);
    const revenueRow = table?.rows.find((row) => row.summaryKey === "totalRevenue");
    expect(revenueRow?.cells.map((cell) => cell.value)).toEqual([100, 150, 100]);
  });

  test("applies financial row semantics to growth color values", () => {
    const table = buildFinancialTableModel({
      annualStatements: [
        {
          date: "2024-12-31",
          totalRevenue: 100,
          costOfRevenue: 50,
          otherIncomeExpense: 1,
          basicShares: 10,
        },
        {
          date: "2025-12-31",
          totalRevenue: 120,
          costOfRevenue: 60,
          otherIncomeExpense: 2,
          basicShares: 9,
        },
      ],
      quarterlyStatements: [],
      priceHistory: [],
    }, {
      period: "annual",
      statement: "income",
      expandAll: true,
    });

    const revenueRow = table?.rows.find((row) => row.summaryKey === "totalRevenue");
    const costRow = table?.rows.find((row) => row.key === "costOfRevenue");
    const otherIncomeRow = table?.rows.find((row) => row.key === "otherIncomeExpense");
    const sharesRow = table?.rows.find((row) => row.key === "basicShares");

    expect(revenueRow?.cells[0]?.semanticGrowth).toBeCloseTo(0.2);
    expect(costRow?.cells[0]?.growth).toBeCloseTo(0.2);
    expect(costRow?.cells[0]?.semanticGrowth).toBeCloseTo(-0.2);
    expect(otherIncomeRow?.cells[0]?.growth).toBeCloseTo(1);
    expect(otherIncomeRow?.cells[0]?.semanticGrowth).toBe(0);
    expect(sharesRow?.cells[0]?.growth).toBeCloseTo(-0.1);
    expect(sharesRow?.cells[0]?.semanticGrowth).toBeCloseTo(0.1);
  });

  test("normalizes shorthand period and statement options", () => {
    expect(resolveFinancialPeriodOption("qtr")).toBe("quarterly");
    expect(resolveFinancialPeriodOption("fy")).toBe("annual");
    expect(resolveFinancialSubTabKey("balance sheet")).toBe("balance");
    expect(resolveFinancialSubTabKey("cf")).toBe("cashflow");
  });
});


test("TTM keeps opening/closing cash and averages period shares instead of summing balances", () => {
  const quarters = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"].map((date, index) => ({
    date, currency: "USD", totalRevenue: 10, beginningCashPosition: 100 + index * 10,
    endCashPosition: 110 + index * 10, changesInCash: 10, totalAssets: 200 + index,
    basicShares: 100 - index * 10, dilutedShares: 110 - index * 10,
  }));
  const ttm = computeTTM([...quarters].reverse());
  expect(ttm).toMatchObject({ currency: "USD", totalRevenue: 40, beginningCashPosition: 100,
    endCashPosition: 140, changesInCash: 40, totalAssets: 203, basicShares: 85, dilutedShares: 95 });
});

test("TTM rejects missing quarters, semiannual reports, and incompatible or partially known currencies", () => {
  const dates = ["2024-06-30", "2024-12-31", "2025-06-30", "2025-12-31"];
  expect(computeTTM(dates.map((date) => ({ date, totalRevenue: 100 })))).toBeNull();
  expect(computeTTM(["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"].map((date, index) => ({
    date, totalRevenue: 100, currency: index === 0 ? "USD" : undefined,
  })))).toBeNull();
  expect(computeTTM(["2024-09-30", "2025-03-31", "2025-06-30", "2025-09-30"].map((date) => ({ date, totalRevenue: 100 })))).toBeNull();
  expect(computeTTM(["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"].map((date, index) => ({
    date, totalRevenue: 100, currency: index === 0 ? "EUR" : "USD",
  })))).toBeNull();
});

test("statement reporting currency stays separate from converted summary fundamentals", () => {
  const summary = { financialCurrency: "TWD", fundamentals: { financialCurrency: "USD" } };
  expect(financialStatementCurrency(summary, [{ date: "2025-12-31", totalRevenue: 3.8e12 }])).toBe("TWD");
  expect(financialStatementCurrency({}, [{ date: "2025-12-31", currency: "TWD" }])).toBe("TWD");
  expect(financialStatementCurrency({ fundamentals: { financialCurrency: "USD" } }, [{ date: "2025-12-31" }])).toBeUndefined();
});

test("growth is unavailable across missing years or a reporting currency change", () => {
  const table = buildFinancialTableModel({ annualStatements: [
    { date: "2022-12-31", currency: "USD", totalRevenue: 100 },
    { date: "2024-12-31", currency: "USD", totalRevenue: 200 },
    { date: "2025-12-31", currency: "EUR", totalRevenue: 180 },
  ], quarterlyStatements: [] });
  expect(table?.rows.find((row) => row.summaryKey === "totalRevenue")?.cells.map((cell) => cell.growth)).toEqual([undefined, undefined, undefined]);
});
