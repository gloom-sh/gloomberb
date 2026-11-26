import { describe, expect, test } from "bun:test";
import type { TickerFinancials } from "../../../../types/financials";
import type { FinancialStatement, ResultsStatementFill } from "../../../../types/financials";
import {
  buildFinancialTableModel,
  computeGrowth,
  computeTTM,
  financialColumnLabel,
  financialColumnName,
  financialLabelWidth,
  financialPeriodEnd,
  financialPeriodWidth,
  formatFinancialCell,
  financialStatementCurrency,
  FINANCIAL_SUB_TABS,
  financialStatementPeriods,
  notInYetNote,
  resolveFinancialPeriodOption,
  resolveFinancialSubTabKey,
  selectFinancialStatements,
  splitPeriodsNotInYet,
  trailingNotInYetNote,
} from "./model";
import { createTestFinancials } from "../../../../test-support/data-provider";
import { RATIO_TABS, ratioOpenings, ratioTableForFinancials } from "./ratios";

function createFinancials(): TickerFinancials {
  return createTestFinancials({
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
  });
}

describe("financial statement table model", () => {
  test("a period holds its widest value and the widest growth whole, or its header or the day it ends where that is wider", () => {
    const values = ["43.49", "-987.65", "1.2"];
    const width = financialPeriodWidth(values, ["FY2024", "FY2023"]);
    for (const value of values) {
      // The longest growth a cell can show, at the period's width: nothing cut, nothing past the column.
      const cell = formatFinancialCell(value, -1e20, width);
      expect(cell.valueText.trim()).toBe(value);
      expect(cell.growthText.trim()).toHaveLength(6);
      expect(`${cell.valueText}${cell.growthText}`.length).toBe(width);
    }
    // The widest value ends the column against its growth, with no blank before it.
    expect(formatFinancialCell("-987.65", 0.1, width).valueText).toBe("-987.65");
    // A header and the two cells the table keeps after one; a day and the same two, drawn in the header's cells.
    expect(financialPeriodWidth(["1.2"], ["Dec 2025 USD (restated)"])).toBe(25);
    expect(financialPeriodWidth(["1.2"], ["FY2025"], ["2025-12-31"])).toBe(12);
    expect(financialPeriodWidth([], [])).toBe(7);
  });

  test("a column is headed by its fiscal period alone, the day it ends left to the first row", () => {
    const year = { date: "2025-09-27", totalRevenue: 1 } as FinancialStatement;
    expect(financialColumnName(year, "annual", 9)).toBe("FY2025");
    expect(financialPeriodEnd(year)).toBe("2025-09-27");
  });

  test("the metric column gives its room to whole periods, and a phone to a second one", () => {
    // 13 cells a period and its gap: three fit a 76-cell web pane beside names 28 wide; five a 96-column terminal.
    expect(financialLabelWidth(76, 13, 6, true)).toBe(28);
    expect(financialLabelWidth(96, 13, 6)).toBe(21);
    // Every period shown: the names keep 28 and the rest is blank.
    expect(financialLabelWidth(160, 13, 6)).toBe(28);
    // A 390 px phone is 48 cells: two periods beside names 15 wide. The terminal, whose names are indented, keeps one.
    expect(financialLabelWidth(48, 13, 6, true)).toBe(15);
    expect(financialLabelWidth(48, 13, 6)).toBe(28);
    // No narrower than 14 for the pair: one period, as before.
    expect(financialLabelWidth(46, 13, 6, true)).toBe(27);
    // Too narrow for a period beside whole names: the names shrink, never below 12.
    expect(financialLabelWidth(36, 13, 6)).toBe(17);
    expect(financialLabelWidth(24, 13, 6)).toBe(12);
    // The ratio tabs' one fixed period, as it was.
    expect(financialLabelWidth(120)).toBe(28);
    expect(financialLabelWidth(40)).toBe(16);
  });

  test("large growth fits beside precise EPS without truncating its sign or percent unit", () => {
    const growth = computeGrowth(0.004125, 0.00000254)!;
    const cell = formatFinancialCell("0.004125", growth);
    expect(cell.valueText.trim()).toBe("0.004125");
    expect(cell.growthText.trim()).toBe("+162k%");
    expect(cell.valueText.length + cell.growthText.length).toBe(18);
    for (const rate of [-999.995, -100, 99.995, 9999.995, 1e12, -1e100, 1e100, -1e307, 1e307]) {
      const formatted = formatFinancialCell("0.004125", rate).growthText.trim();
      expect(formatted.endsWith("%")).toBe(true);
      expect(formatted.length).toBeLessThanOrEqual(6);
      expect(formatted).toContain(rate < 0 ? "-" : formatted.startsWith(">") ? ">" : "+");
    }
    expect(computeGrowth(Number.MAX_VALUE, Number.MIN_VALUE)).toBeUndefined();
    expect(computeGrowth(-Number.MAX_VALUE, Number.MAX_VALUE)).toBe(-2);
    // Off a zero or negative base: not meaningful, and the cell says so.
    expect(computeGrowth(Number.MAX_VALUE, -Number.MAX_VALUE)).toBe("not-meaningful");
    expect(computeGrowth(5, -10)).toBe("not-meaningful");
    expect(computeGrowth(-5, -10)).toBe("not-meaningful");
    expect(computeGrowth(5, 0)).toBe("not-meaningful");
    expect(formatFinancialCell("5", computeGrowth(5, -10)).growthText.trim()).toBe("N/M");
    // An outflow grows as the money that went out: capex from -10 to -12 is a fifth more spent.
    expect(computeGrowth(-12, -10, true)).toBeCloseTo(0.2, 10);
    expect(computeGrowth(3, -10, true)).toBe("not-meaningful");
    expect(formatFinancialCell("1", Number.POSITIVE_INFINITY).growthText.trim()).toBe("");
  });

  test("leads with a TTM column only once the last four quarters run past the latest fiscal year", () => {
    const financials = createFinancials();
    const dates = () => buildFinancialTableModel(financials, { period: "annual", statement: "income" })
      ?.statements.map((statement) => statement.date);
    // The four quarters of 2025 are FY2025 itself.
    expect(dates()).toEqual(["2025-12-31", "2024-12-31"]);
    financials.quarterlyStatements.push({ date: "2026-03-31", totalRevenue: 50, netIncome: 5 });
    const table = buildFinancialTableModel(financials, { period: "annual", statement: "income" });
    expect(table?.period).toBe("annual");
    expect(table?.statements.map((statement) => statement.date)).toEqual(["TTM", "2025-12-31", "2024-12-31"]);
    const revenueRow = table?.rows.find((row) => row.summaryKey === "totalRevenue");
    expect(revenueRow?.cells.map((cell) => cell.value)).toEqual([140, 150, 100]);
  });

  // REF: SEC fiscal year-end balance points sit among the quarterly rows.
  test("omits periods with nothing on the selected statement", () => {
    const financials = createFinancials();
    financials.quarterlyStatements.splice(3, 0, { date: "2025-10-04", totalAssets: 900, totalEquity: 400, dateSource: "sec" });
    const dates = (statement: string) => buildFinancialTableModel(financials, { period: "quarterly", statement, quarterlyLimit: 4 })
      ?.statements.map((row) => row.date);
    expect(dates("income")).toEqual(["2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31"]);
    expect(dates("balance")).toEqual(["2025-10-04"]);
  });

  test("hides lines that repeat their group's headline in every shown period", () => {
    const labels = (netIncomeCommonStockholders: number) => buildFinancialTableModel(createTestFinancials({
      annualStatements: [
        { date: "2024-12-31", totalRevenue: 100, operatingRevenue: 100, netIncome: 25, netIncomeCommonStockholders: 25, eps: 1 },
        { date: "2025-12-31", totalRevenue: 150, operatingRevenue: 150, netIncome: 45, netIncomeCommonStockholders, eps: 2 },
      ],
    }), { period: "annual", statement: "income", expandAll: true })?.rows.map((row) => row.unitLabel) ?? [];
    expect(labels(45)).not.toContain("Operating Revenue");
    expect(labels(45)).not.toContain("Income Common");
    expect(labels(44)).toContain("Income Common");
    expect(labels(45)).toContain("Diluted EPS");
  });

  // MSFT cash flow: D&A and Depreciation, Buybacks and Stock Payments.
  test("hides a line that repeats a sibling above it in every shown period", () => {
    const labels = (depreciation: number) => buildFinancialTableModel(createTestFinancials({
      annualStatements: [
        { date: "2024-12-31", operatingCashFlow: 100, depreciationAndAmortization: 20, depreciation: 20, stockBasedCompensation: 5 },
        { date: "2025-12-31", operatingCashFlow: 120, depreciationAndAmortization: 30, depreciation, stockBasedCompensation: 6 },
      ],
    }), { period: "annual", statement: "cashflow", expandAll: true })?.rows.map((row) => row.unitLabel) ?? [];
    expect(labels(30)).toContain("D&A");
    expect(labels(30)).not.toContain("Depreciation");
    expect(labels(25)).toContain("Depreciation");
  });

  test("applies financial row semantics to growth color values", () => {
    const table = buildFinancialTableModel(createTestFinancials({
      financialCurrency: "USD",
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
    }), {
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

test("annual growth finds a unique prior year around interleaved ADR EPS observations", () => {
  const annualStatements = [
    { date: "2025-03-31", currency: "JPY", totalRevenue: 48_036_704_000_000, eps: 3595.6 },
    { date: "2025-06-30", currency: "JPY", eps: 3251.3 },
    { date: "2025-09-30", currency: "JPY", eps: 3534.8 },
    { date: "2026-03-31", currency: "JPY", totalRevenue: 50_684_952_000_000, eps: 2952.5 },
  ];
  const model = () => buildFinancialTableModel({ annualStatements, quarterlyStatements: [] }, {
    period: "annual", statement: "income", expandAll: true,
  })!;
  const revenue = (table: ReturnType<typeof model>) => table.rows.find((row) => row.summaryKey === "totalRevenue")!.cells[0]!;
  const table = model();
  expect(revenue(table)).toMatchObject({ value: 50_684_952_000_000 });
  expect(revenue(table).growth).toBeCloseTo(0.0551296775);
  expect(table.rows.find((row) => row.key === "eps")!.cells[0]!.growth).toBeCloseTo(-0.1788574925);
  expect(table.statements.map((row) => row.date)).toEqual([...annualStatements].reverse().map((row) => row.date));

  annualStatements[0]!.currency = "USD";
  expect(revenue(model()).growth).toBeUndefined();
  annualStatements[0]!.currency = "JPY";
  annualStatements.splice(1, 0, { date: "2025-04-30", currency: "JPY", totalRevenue: 49_000_000_000_000, eps: 3500 });
  expect(revenue(model()).growth).toBeUndefined();
});

test("annual balance sheets show the latest dated snapshot with comparable year-on-year growth", () => {
  const financials = {
    annualStatements: [{ date: "2025-12-31", currency: "USD", totalAssets: 200 }],
    quarterlyStatements: [
      { date: "2025-06-30", currency: "USD", totalAssets: 160 },
      { date: "2026-06-30", currency: "USD", totalAssets: 240 },
    ],
  };
  const table = buildFinancialTableModel(financials, { period: "annual", statement: "balance" })!;
  expect(table.statements.map(({ date }) => date)).toEqual(["2026-06-30", "2025-12-31"]);
  expect(table.rows.find(({ summaryKey }) => summaryKey === "totalAssets")?.cells[0]).toMatchObject({ value: 240, growth: 0.5 });
  financials.quarterlyStatements[0]!.currency = "EUR";
  const changedCurrency = buildFinancialTableModel(financials, { period: "annual", statement: "balance" })!;
  expect(changedCurrency.rows.find(({ summaryKey }) => summaryKey === "totalAssets")?.cells[0]?.growth).toBeUndefined();
  financials.quarterlyStatements = [{ date: "2025-12-31", currency: "USD", totalAssets: 200 }];
  expect(buildFinancialTableModel(financials, { period: "annual", statement: "balance" })?.statements.map(({ date }) => date)).toEqual(["2025-12-31"]);
});

test("an EPS-only quarter cannot replace the latest available balance sheet", () => {
  // Reduced from the public BAC capture: June coverage has EPS but no balance sheet.
  const financials: TickerFinancials = createTestFinancials({
    annualStatements: [{ date: "2025-12-31", currency: "USD", totalAssets: 3_411_738_000_000 }],
    quarterlyStatements: [
      { date: "2025-03-31", currency: "USD", totalAssets: 3_349_424_000_000 },
      { date: "2026-03-31", currency: "USD", totalAssets: 3_496_186_000_000 },
      { date: "2026-06-30", currency: "USD", eps: 1.21 },
    ],
  });
  const source = structuredClone(financials);
  const balance = buildFinancialTableModel(financials, { period: "annual", statement: "balance" })!;
  expect(balance.statements.map(({ date }) => date)).toEqual(["2026-03-31", "2025-12-31"]);
  const assets = balance.rows.find(({ summaryKey }) => summaryKey === "totalAssets")!.cells[0]!;
  expect(assets.value).toBe(3_496_186_000_000);
  expect(assets.growth).toBeCloseTo(3_496_186_000_000 / 3_349_424_000_000 - 1);
  const income = buildFinancialTableModel(financials, { period: "quarterly", statement: "income", expandAll: true })!;
  expect(income.statements[0]!.date).toBe("2026-06-30");
  expect(income.rows.find(({ key }) => key === "eps")!.cells[0]!.value).toBe(1.21);
  expect(financials).toEqual(source);

  // Missing/non-finite fields are not balance coverage, but a reported zero is.
  financials.quarterlyStatements.at(-1)!.totalAssets = NaN;
  expect(buildFinancialTableModel(financials, { period: "annual", statement: "balance" })!.statements[0]!.date).toBe("2026-03-31");
  financials.quarterlyStatements.at(-1)!.totalDebt = 0;
  const zero = buildFinancialTableModel(financials, { period: "annual", statement: "balance", expandAll: true })!;
  expect(zero.statements[0]!.date).toBe("2026-06-30");
  expect(zero.rows.find(({ key }) => key === "totalDebt")!.cells[0]!.value).toBe(0);
});

test("liabilities plus equity requires its own components and cannot copy total assets", () => {
  const table = buildFinancialTableModel({
    annualStatements: [
      { date: "2022-12-31", totalAssets: 100, totalLiabilities: 60, totalEquityGrossMinorityInterest: 35 },
      { date: "2023-12-31", totalAssets: 110, totalLiabilities: 70, totalEquity: 40 },
      { date: "2024-12-31", totalAssets: 120, totalLiabilities: 80, totalEquityGrossMinorityInterest: 0 },
      { date: "2025-12-31", totalAssets: 130 },
    ],
    quarterlyStatements: [],
  }, { period: "annual", statement: "balance" })!;
  const total = table.rows.find(({ id }) => id === "balance:liabilities-equity:0")!;
  expect(total.cells.map(({ value }) => value)).toEqual([undefined, 80, undefined, 95]);
  expect(total.cells[0]!.valueText.trim()).toBe("—");
  expect(table.rows.find(({ summaryKey }) => summaryKey === "totalAssets")!.cells.map(({ value }) => value)).toEqual([130, 120, 110, 100]);
});

test("a newest year with only some figures (an EPS alone) is left out of the columns and named, so its first column is never all dashes", () => {
  // Pop Mart on 2026-11-11: FY2025 carried its EPS but none of its statement.
  const annual = [
    { date: "2023-12-31", totalRevenue: 6.3e9, eps: 0.81 },
    { date: "2024-12-31", totalRevenue: 13.04e9, eps: 2.35 },
    { date: "2025-12-31", eps: 9.58 },
  ];
  const income = FINANCIAL_SUB_TABS.find((tab) => tab.key === "income")!;
  const { statements, notInYet } = selectFinancialStatements("annual", "income", annual, []);
  expect(statements.map((statement) => statement.date)).toEqual(["2024-12-31", "2023-12-31"]);
  expect(notInYet.map((statement) => statement.date)).toEqual(["2025-12-31"]);
  expect(notInYetNote(notInYet, income, "annual", 12)).toBe("FY2025 is not in yet: only its EPS is on file (9.58 diluted), not its revenue.");
  // Leaving them out twice changes nothing.
  expect(splitPeriodsNotInYet(statements, income).shown).toEqual(statements);
  // A year with more than its EPS (its net income) is not EPS-only.
  expect(notInYetNote([{ date: "2025-12-31", eps: 9.58, netIncome: 12e9 }], income, "annual", 12))
    .toBe("FY2025 is not in yet: only some of its figures are on file, not its revenue.");
  // A table where no year has the lead line keeps them all: there is nothing newer to lead with.
  expect(splitPeriodsNotInYet([{ date: "2025-12-31", eps: 1 }], income).shown).toHaveLength(1);
});

test("a quarter whose revenue Gloom Cloud left blank because the announcements count it otherwise is in", () => {
  // HSBC's 3Q26: net income and EPS from its earnings release, its revenue left out (the source counts it otherwise).
  const omitted = {
    date: "2026-09-30", netIncome: 7.55e9, eps: 0.41,
    filledFrom: { source: "results" as const, fields: ["netIncome" as const, "eps" as const], documents: [], lines: {}, omitted: ["totalRevenue" as const] },
  };
  const quarters = [omitted, { date: "2026-06-30", eps: 0.45 }, { date: "2026-03-31", totalRevenue: 19.13e9, netIncome: 7.34e9, eps: 0.4 }];
  const income = FINANCIAL_SUB_TABS.find((tab) => tab.key === "income")!;
  const { shown, notInYet } = splitPeriodsNotInYet(quarters, income);
  expect(shown.map((statement) => statement.date)).toEqual(["2026-09-30", "2026-06-30", "2026-03-31"]);
  expect(notInYet).toEqual([]);
  expect(financialStatementPeriods(quarters, income).map(({ lead }) => lead)).toEqual([true, false, true]);
  // Without the reason the newest quarter is not in yet, as before.
  expect(splitPeriodsNotInYet([{ ...omitted, filledFrom: { ...omitted.filledFrom, omitted: [] } }, quarters[2]!], income).notInYet).toHaveLength(1);
});

test("a half-yearly reporter's TTM is Gloom Cloud's year plus the half, when it is newer than the year", () => {
  const trailing = {
    date: "2026-06-30", currency: "CNY", totalRevenue: 40.42e9, netIncome: 13.24e9,
    trailing: {
      method: "annual-plus-interim" as const, annual: "2025-12-31",
      interim: { end: "2026-06-30", months: 6 }, priorInterim: { end: "2025-06-30", months: 6 },
      basis: "FY to 2025-12-31 + 6 months to 2026-06-30 − 6 months to 2025-06-30",
    },
  };
  const financials = createTestFinancials({
    annualStatements: [{ date: "2025-12-31", currency: "CNY", totalRevenue: 37.12e9, netIncome: 12.78e9 }],
    // Halves, not quarters: no four-quarter sum.
    quarterlyStatements: [
      { date: "2025-06-30", currency: "CNY", totalRevenue: 13.88e9 },
      { date: "2026-06-30", currency: "CNY", totalRevenue: 17.17e9 },
    ],
    trailingStatement: trailing,
  });
  const table = buildFinancialTableModel(financials, { period: "annual", statement: "income" })!;
  expect(table.statements.map(({ date }) => date)).toEqual(["TTM", "2025-12-31"]);
  expect(table.statements[0]).toMatchObject({
    totalRevenue: 40.42e9,
    aggregation: { kind: "annual-plus-interim", periodEnd: "2026-06-30", basis: trailing.trailing.basis },
  });
  // Not on the balance sheet, and not once the year it runs to is on file.
  expect(buildFinancialTableModel(financials, { period: "annual", statement: "balance" })!.statements.map(({ date }) => date)).not.toContain("TTM");
  const later = { ...financials, annualStatements: [...financials.annualStatements, { date: "2026-06-30", currency: "CNY", totalRevenue: 40e9 }] };
  expect(buildFinancialTableModel(later, { period: "annual", statement: "income" })!.statements.map(({ date }) => date)).not.toContain("TTM");
});

/** A half Gloom Cloud filled into the quarterly list from a results announcement. */
function half(date: string, totalRevenue: number): FinancialStatement {
  const filledFrom: ResultsStatementFill = {
    source: "results", fields: ["totalRevenue"], periodMonths: 6,
    documents: [{ source: "hkex", kind: "interim_results", title: "Interim Results", url: "https://www1.hkexnews.hk/x.pdf", publishedAt: `${date.slice(0, 4)}-08-20T08:30:00Z`, fetchedAt: "2026-11-11T00:00:00Z" }],
    lines: { totalRevenue: { document: 0, page: 3 } },
  };
  return { date, currency: "CNY", totalRevenue, filledFrom };
}

const HALF_TRAILING = {
  date: "2026-06-30", currency: "CNY", totalRevenue: 40.42e9,
  trailing: {
    method: "annual-plus-interim" as const, annual: "2025-12-31",
    interim: { end: "2026-06-30", months: 6 }, priorInterim: { end: "2025-06-30", months: 6 },
    basis: "FY to 2025-12-31 + 6 months to 2026-06-30 − 6 months to 2025-06-30",
  },
};

test("a filled half is never summed as a quarter, compared with one, or headed as one", () => {
  const quarters = [
    { date: "2025-03-31", currency: "CNY", totalRevenue: 10 },
    { date: "2025-06-30", currency: "CNY", totalRevenue: 20 },
    { date: "2025-09-30", currency: "CNY", totalRevenue: 30 },
    { date: "2025-12-31", currency: "CNY", totalRevenue: 40 },
  ];
  // Four quarters to December; the half after them is not a fifth.
  expect(computeTTM([...quarters, half("2026-06-30", 170)])).toMatchObject({ totalRevenue: 100, aggregation: { periodEnd: "2025-12-31" } });
  // Three quarters and a half are not four quarters.
  expect(computeTTM([...quarters.slice(1), half("2026-03-31", 170)])).toBeNull();
  const financials = createTestFinancials({
    annualStatements: [{ date: "2025-12-31", currency: "CNY", totalRevenue: 100 }],
    quarterlyStatements: [...quarters, half("2026-06-30", 170)],
  });
  const table = buildFinancialTableModel(financials, { period: "quarterly", statement: "income" })!;
  expect(table.statements[0]!.date).toBe("2026-06-30");
  expect(financialColumnLabel(table.statements[0]!, "quarterly", 12)).toBe("H1 FY26");
  expect(financialColumnLabel(table.statements[1]!, "quarterly", 12)).toBe("Q4 FY25");
  const revenue = table.rows.find(({ key, summaryKey }) => (key ?? summaryKey) === "totalRevenue")!;
  // No change from the December quarter to the half; the quarters keep theirs.
  expect(revenue.cells[0]!.growth).toBeUndefined();
  expect(revenue.cells[1]!.growth).toBeCloseTo(40 / 30 - 1, 6);
  // Not even one a quarter after it.
  const offCycle = buildFinancialTableModel({ ...financials, quarterlyStatements: [...quarters, half("2026-03-31", 170)] }, { period: "quarterly", statement: "income" })!;
  expect(financialColumnLabel(offCycle.statements[0]!, "quarterly", 12)).toBe("6M 2026-03-31");
  // The pane's header leaves the day to the Period end row.
  expect(financialColumnName(offCycle.statements[0]!, "quarterly", 12)).toBe("6M");
  expect(offCycle.rows.find(({ key, summaryKey }) => (key ?? summaryKey) === "totalRevenue")!.cells[0]!.growth).toBeUndefined();
});

test("the year plus the half: headed TTM H1, its growth only against twelve months to a year before", () => {
  const annual = [
    { date: "2024-12-31", currency: "CNY", totalRevenue: 13.04e9 },
    { date: "2025-12-31", currency: "CNY", totalRevenue: 37.12e9 },
  ];
  const halves = createTestFinancials({
    annualStatements: annual,
    quarterlyStatements: [half("2025-06-30", 13.88e9), half("2026-06-30", 17.17e9)],
    trailingStatement: HALF_TRAILING,
  });
  const table = buildFinancialTableModel(halves, { period: "annual", statement: "income" })!;
  expect(table.statements[0]!.aggregation).toMatchObject({ kind: "annual-plus-interim", interimMonths: 6 });
  expect(financialColumnLabel(table.statements[0]!, "annual", 12)).toBe("TTM H1 FY26");
  const revenue = (model: typeof table) => model.rows.find(({ key, summaryKey }) => (key ?? summaryKey) === "totalRevenue")!;
  // No twelve months to June 2025 on file: no growth, never against FY2025.
  expect(revenue(table).cells[0]!.growth).toBeUndefined();
  expect(revenue(table).cells[1]!.growth).toBeCloseTo(37.12 / 13.04 - 1, 6);
  // Four quarters to June 2025 are the same window a year earlier.
  const quarterly = createTestFinancials({
    annualStatements: annual,
    quarterlyStatements: [
      { date: "2024-09-30", currency: "CNY", totalRevenue: 3e9 },
      { date: "2024-12-31", currency: "CNY", totalRevenue: 4e9 },
      { date: "2025-03-31", currency: "CNY", totalRevenue: 6e9 },
      { date: "2025-06-30", currency: "CNY", totalRevenue: 7e9 },
    ],
    trailingStatement: HALF_TRAILING,
  });
  const withPrior = buildFinancialTableModel(quarterly, { period: "annual", statement: "income" })!;
  expect(withPrior.statements[0]!.aggregation?.kind).toBe("annual-plus-interim");
  expect(revenue(withPrior).cells[0]!.growth).toBeCloseTo(40.42 / 20 - 1, 6);
});

test("four quarters that would mix two definitions of revenue give way to the served year plus nine months", () => {
  // A bank's latest quarters as it announces them (revenue before credit losses), its earlier ones as a source counts them.
  const quarterlyStatements = [
    { date: "2025-12-31", currency: "USD", totalRevenue: 17.72e9, netIncome: 4.94e9 },
    { date: "2026-03-31", currency: "USD", totalRevenue: 19.13e9, netIncome: 7.34e9 },
    { date: "2026-06-30", currency: "USD", totalRevenue: 19.12e9, netIncome: 7.91e9 },
    { date: "2026-09-30", currency: "USD", totalRevenue: 18.62e9, netIncome: 7.55e9 },
  ];
  const trailing = {
    date: "2026-09-30", currency: "USD", totalRevenue: 72.73e9, netIncome: 27.75e9,
    trailing: {
      method: "annual-plus-interim" as const, annual: "2025-12-31",
      interim: { end: "2026-09-30", months: 9 }, priorInterim: { end: "2025-09-30", months: 9 },
      basis: "FY to 2025-12-31 + 9 months to 2026-09-30 − 9 months to 2025-09-30",
    },
  };
  const annualStatements = [{ date: "2025-12-31", currency: "USD", totalRevenue: 68.27e9, netIncome: 22.92e9 }];
  const ttmRevenue = (served: typeof trailing & { trailing: { overQuarters?: string } }) => {
    const table = buildFinancialTableModel(createTestFinancials({ annualStatements, quarterlyStatements, trailingStatement: served }), { period: "annual", statement: "income" })!;
    return table.statements[0]!.totalRevenue;
  };
  // Summable quarters stand.
  expect(ttmRevenue(trailing)).toBeCloseTo(74.59e9, -6);
  // Told they are not, the served year plus nine months does.
  expect(ttmRevenue({ ...trailing, trailing: { ...trailing.trailing, overQuarters: "the quarters count revenue otherwise" } })).toBe(72.73e9);
});

test("a margin over negative revenue reads N/M; a loss's growth reads N/M; capex grows as spending does", () => {
  const financials = createTestFinancials({
    annualStatements: [
      { date: "2024-12-31", currency: "USD", totalRevenue: 50, grossProfit: 10, operatingIncome: -20, netIncome: -15, capitalExpenditure: -10, operatingCashFlow: 5, freeCashFlow: -5 },
      // Revenue turned negative (a reversal of fair value gains, say): no margin over it means anything.
      { date: "2025-12-31", currency: "USD", totalRevenue: -4, grossProfit: -9, operatingIncome: -30, netIncome: 6, capitalExpenditure: -12, operatingCashFlow: 8, freeCashFlow: -4 },
    ],
    quarterlyStatements: [],
  });
  const income = buildFinancialTableModel(financials, { period: "annual", statement: "income", expandAll: true })!;
  const cell = (model: typeof income, id: string) => model.rows.find((row) => (row.key ?? row.summaryKey ?? row.id.split(":")[0]) === id)!.cells[0]!;
  expect(cell(income, "gross-margin").valueText.trim()).toBe("N/M");
  expect(cell(income, "net-margin").valueText.trim()).toBe("N/M");
  // A year earlier, over positive revenue, the margins are numbers.
  expect(income.rows.find((row) => row.id.startsWith("gross-margin"))!.cells[1]!.valueText.trim()).toBe("20.0%");
  // Net income from a loss of 15 to a profit of 6: no percentage of the loss.
  expect(cell(income, "netIncome").growthText.trim()).toBe("N/M");
  expect(cell(income, "netIncome").growth).toBeUndefined();
  // Revenue from 50 to -4 falls 108%: a positive base, so a number.
  expect(cell(income, "totalRevenue").growth).toBeCloseTo(-54 / 50, 10);
  const cashflow = buildFinancialTableModel(financials, { period: "annual", statement: "cashflow", expandAll: true })!;
  expect(cell(cashflow, "capitalExpenditure").growth).toBeCloseTo(0.2, 10);
  expect(cell(cashflow, "freeCashFlow").growthText.trim()).toBe("N/M");
});

test("a filled half's growth is against the same half a year earlier, never a quarter's", () => {
  const halves = createTestFinancials({
    annualStatements: [{ date: "2025-12-31", currency: "CNY", totalRevenue: 37.12e9 }],
    quarterlyStatements: [half("2025-06-30", 13.88e9), half("2026-06-30", 17.17e9)],
  });
  const table = buildFinancialTableModel(halves, { period: "quarterly", statement: "income" })!;
  const revenue = table.rows.find(({ key, summaryKey }) => (key ?? summaryKey) === "totalRevenue")!;
  expect(table.statements.map(({ date }) => date)).toEqual(["2026-06-30", "2025-06-30"]);
  expect(revenue.cells[0]!.growth).toBeCloseTo(17.17 / 13.88 - 1, 6);
  // A quarter a year before the half is no half.
  const quarter = buildFinancialTableModel({ ...halves, quarterlyStatements: [{ date: "2025-06-30", currency: "CNY", totalRevenue: 7e9 }, half("2026-06-30", 17.17e9)] },
    { period: "quarterly", statement: "income" })!;
  expect(quarter.rows.find(({ key, summaryKey }) => (key ?? summaryKey) === "totalRevenue")!.cells[0]!.growth).toBeUndefined();
});

test("a filled year's growth against the source's year before: the lines the server finds restated alike, every line where it does not say", () => {
  // Pop Mart: FY2025 revenue and net income from the annual results, whose 2024 revenue is the source's 13,037.7m.
  const fy2025 = (comparable?: ResultsStatementFill["comparable"]): FinancialStatement => ({
    date: "2025-12-31", currency: "CNY", totalRevenue: 37.12e9, netIncome: 12.78e9,
    filledFrom: {
      source: "results", fields: ["totalRevenue", "netIncome"],
      documents: [{ source: "hkex", kind: "annual_results", title: "Annual Results", url: "https://www1.hkexnews.hk/a.pdf", publishedAt: "2026-03-25T04:22:00Z", fetchedAt: "2026-11-11T00:00:00Z" }],
      lines: { totalRevenue: { document: 0, page: 2 }, netIncome: { document: 0, page: 2 } },
      ...(comparable ? { comparable } : {}),
    },
  });
  const growth = (row: FinancialStatement, key: string) => buildFinancialTableModel(createTestFinancials({
    annualStatements: [{ date: "2024-12-31", currency: "CNY", totalRevenue: 13.04e9, netIncome: 3.13e9 }, row],
  }), { period: "annual", statement: "income" })!.rows.find((model) => (model.key ?? model.summaryKey) === key)!.cells[0]!.growth;
  expect(growth(fy2025(["totalRevenue"]), "totalRevenue")).toBeCloseTo(37.12 / 13.04 - 1, 6);
  // Net income is not restated alike: no growth across the two sources.
  expect(growth(fy2025(["totalRevenue"]), "netIncome")).toBeUndefined();
  expect(growth(fy2025([]), "totalRevenue")).toBeUndefined();
  // A server that predates the check says nothing: the filled year has its year-on-year growth all the same.
  expect(growth(fy2025(), "totalRevenue")).toBeCloseTo(37.12 / 13.04 - 1, 6);
  expect(growth(fy2025(), "netIncome")).toBeCloseTo(12.78 / 3.13 - 1, 6);
});

test("a quarterly reporter missing a quarter's lines: the served TTM to the same day, not four quarters without them", () => {
  // Meituan: no Q3 2025 revenue on file; Gloom Cloud's FY2025 + H1 2026 − H1 2025 runs to June too.
  const trailing = {
    date: "2026-06-30", currency: "CNY", totalRevenue: 382.84e9, netIncome: -38.45e9,
    trailing: {
      method: "annual-plus-interim" as const, annual: "2025-12-31",
      interim: { end: "2026-06-30", months: 6 }, priorInterim: { end: "2025-06-30", months: 6 },
      basis: "FY to 2025-12-31 + 6 months to 2026-06-30 − 6 months to 2025-06-30",
    },
  };
  const quarters = [
    { date: "2025-09-30", currency: "CNY", grossProfit: 10e9 },
    { date: "2025-12-31", currency: "CNY", totalRevenue: 92.1e9, netIncome: -15.14e9 },
    { date: "2026-03-31", currency: "CNY", totalRevenue: 91.04e9, netIncome: -6.83e9 },
    { date: "2026-06-30", currency: "CNY", totalRevenue: 104.64e9, netIncome: 2.15e9 },
  ];
  const financials = createTestFinancials({
    annualStatements: [{ date: "2025-12-31", currency: "CNY", totalRevenue: 364.8e9, netIncome: -23.4e9 }],
    quarterlyStatements: quarters,
    trailingStatement: trailing,
  });
  const table = buildFinancialTableModel(financials, { period: "annual", statement: "income" })!;
  expect(table.statements[0]).toMatchObject({ date: "TTM", totalRevenue: 382.84e9, aggregation: { kind: "annual-plus-interim", periodEnd: "2026-06-30" } });
  // With the quarter's lines on file, its four quarters as before.
  const whole = buildFinancialTableModel({ ...financials, quarterlyStatements: [{ date: "2025-09-30", currency: "CNY", totalRevenue: 95.5e9, netIncome: 1e9 }, ...quarters.slice(1)] },
    { period: "annual", statement: "income" })!;
  expect(whole.statements[0]!.aggregation?.kind).toBe("trailing-four-quarters");
  // A served TTM to a day a few days before the quarters' (2026-06-28 against 2026-06-30) is the same period:
  // still the served one where the quarters lack revenue, not the newer-looking four.
  const nearby = buildFinancialTableModel({ ...financials, trailingStatement: { ...trailing, date: "2026-06-28",
    trailing: { ...trailing.trailing, interim: { end: "2026-06-28", months: 6 } } } }, { period: "annual", statement: "income" })!;
  expect(nearby.statements[0]).toMatchObject({ date: "TTM", totalRevenue: 382.84e9, aggregation: { kind: "annual-plus-interim" } });
});

test("a cash flow table is in one unit, shows a line once, and works out capex intensity and the reinvestment rate", () => {
  // Visa's FY2026 cash flow, in USD: depreciation and payables changes a thousandth of the rest, capex reported twice.
  const year = (date: string, scale: number) => ({
    date, currency: "USD", totalRevenue: 45.903e9 * scale, operatingIncome: 28.11e9 * scale, pretaxIncome: 28.093e9 * scale,
    taxProvision: 4.589e9 * scale, freeCashFlow: 22.057e9 * scale, operatingCashFlow: 23.728e9 * scale, capitalExpenditure: -1.671e9 * scale,
    purchaseOfPPE: -1.671e9 * scale, purchaseOfBusiness: -0.705e9 * scale, depreciationAndAmortization: 1.403e9 * scale,
    changeInAccountPayable: 1e6 * scale, stockBasedCompensation: 0.928e9 * scale, netIncome: 23.504e9 * scale,
  });
  const model = buildFinancialTableModel(createTestFinancials({ annualStatements: [year("2025-09-30", 0.9), year("2026-09-30", 1)] }),
    { period: "annual", statement: "cashflow", expandAll: true })!;
  expect(model.unit).toBe("bn");
  // No row names a unit of its own: the header's bn is every amount's.
  expect(model.rows.filter((row) => /\((?:k|mn|bn|tn)\)$/.test(row.unitLabel)).map((row) => row.unitLabel)).toEqual([]);
  const cell = (label: string) => model.rows.find((row) => row.label === label)?.cells[0]?.valueText.trim();
  expect(cell("Stock-Based Comp")).toBe("0.928");
  expect(cell("Acct Payable")).toBe("0.001");
  // Operating cash flow is the Operating group's line, and Purchase PPE equals CapEx in every year: each is shown once.
  expect(model.rows.filter((row) => row.label === "Operating CF" || row.label === "Purchase PPE")).toEqual([]);
  expect(model.rows.filter((row) => row.label === "CapEx")).toHaveLength(1);
  expect(cell("CapEx / Revenue")).toBe("3.6%");
  // (1.671 + 0.705 - 1.403) / (28.11 x (1 - 4.589 / 28.093)) = 4.1%.
  expect(cell("Reinvestment Rate")).toBe("4.1%");
});

/**
 * NVIDIA on 2026-11-24: Q3 FY27 (to 2026-10-25) was in its earnings release, not yet in a 10-Q, so its row carried
 * only its EPS and share counts, under the month-end label 2026-10-31. Eight full quarters before it.
 */
function epsOnlyQuarterFinancials(): TickerFinancials {
  const ends = ["2024-10-27", "2025-01-26", "2025-04-27", "2025-07-27", "2025-10-26", "2026-01-25", "2026-04-26", "2026-07-26"];
  const revenue = [35, 39, 44, 47, 57, 68, 82, 96];
  const quarter = (date: string, index: number): FinancialStatement => {
    const sales = revenue[index]! * 1e9;
    return {
      date, currency: "USD", totalRevenue: sales, operatingIncome: sales * 0.6, netIncome: sales * 0.55, eps: sales * 0.55 / 24.3e9,
      dilutedShares: 24.3e9, operatingCashFlow: sales * 0.4, freeCashFlow: sales * 0.37, capitalExpenditure: -sales * 0.03,
      totalAssets: 200e9 + index * 15e9, totalEquity: 150e9 + index * 10e9, currentAssets: 120e9, currentLiabilities: 40e9,
    };
  };
  return createTestFinancials({
    financialCurrency: "USD",
    annualStatements: [
      { date: "2025-01-26", currency: "USD", totalRevenue: 130.5e9, operatingIncome: 81.5e9, netIncome: 72.9e9, eps: 2.94, operatingCashFlow: 64.1e9, freeCashFlow: 60.9e9, totalAssets: 111.6e9, totalEquity: 79.3e9 },
      { date: "2026-01-25", currency: "USD", totalRevenue: 215.9e9, operatingIncome: 130.4e9, netIncome: 120.1e9, eps: 4.9, operatingCashFlow: 102.7e9, freeCashFlow: 96.7e9, totalAssets: 206.8e9, totalEquity: 157.3e9 },
    ],
    quarterlyStatements: [
      ...ends.map(quarter),
      { date: "2026-10-31", currency: "USD", basicShares: 24.106e9, dilutedShares: 24.186e9, basicEps: 2.71, eps: 2.7 },
    ],
  });
}

describe("a quarter with only its EPS, between its earnings release and its 10-Q", () => {
  const financials = epsOnlyQuarterFinancials();
  const annual = financials.annualStatements;
  const quarterly = financials.quarterlyStatements;

  test("the annual TTM runs to the last quarter with its statements, not to a column of dashes", () => {
    for (const statement of ["income", "cashflow"]) {
      const { statements, previousStatementMap, notInYet } = selectFinancialStatements("annual", statement, annual, quarterly);
      expect(statements.map(({ date }) => date)).toEqual(["TTM", "2026-01-25", "2025-01-26"]);
      expect(statements[0]!.aggregation).toMatchObject({ kind: "trailing-four-quarters", periodEnd: "2026-07-26" });
      expect(notInYet).toEqual([]);
      if (statement === "income") {
        expect(statements[0]!.totalRevenue).toBe((57 + 68 + 82 + 96) * 1e9);
        // Its growth is over the four quarters before its own.
        expect(previousStatementMap.get("TTM")!.totalRevenue).toBe((35 + 39 + 44 + 47) * 1e9);
      }
    }
    const table = buildFinancialTableModel(financials, { period: "annual", statement: "income", expandAll: true })!;
    expect(financialColumnLabel(table.statements[0]!, "annual", 1)).toBe("TTM Q2 FY27");
    // A line says why it stops there.
    expect(table.trailingNotInYet.map(({ date }) => date)).toEqual(["2026-10-31"]);
    expect(trailingNotInYetNote(table.statements, table.trailingNotInYet, table.subTab, 1))
      .toBe("Q3 FY27 is not in yet: only its EPS is on file (2.70 diluted), not its revenue, so the TTM runs to Q2 FY27.");
    // A TTM that stops at a gap in the quarters, not at a quarter missing its lines, says nothing of the kind.
    const gap = selectFinancialStatements("annual", "income", annual, [...quarterly.slice(0, 7), { ...quarterly[7]!, date: "2026-10-25" }]);
    expect(gap.statements[0]!.aggregation?.periodEnd).toBe("2026-04-26");
    expect(gap.trailingNotInYet).toEqual([]);
    expect(table.rows.find(({ summaryKey, key }) => (summaryKey ?? key) === "totalRevenue")!.cells[0]!.value).toBe(303e9);
  });

  test("the quarterly tables leave the quarter out and say what is on file for it", () => {
    for (const statement of ["income", "cashflow", "balance"]) {
      const table = buildFinancialTableModel(financials, { period: "quarterly", statement, expandAll: true })!;
      expect(table.statements[0]!.date).toBe("2026-07-26");
      // The cash flow and balance sheet have nothing of it: it is no period of theirs, and nothing is said.
      expect(table.notInYet.map(({ date }) => date)).toEqual(statement === "income" ? ["2026-10-31"] : []);
    }
    const income = FINANCIAL_SUB_TABS.find((tab) => tab.key === "income")!;
    const { notInYet } = selectFinancialStatements("quarterly", "income", annual, quarterly);
    expect(notInYetNote(notInYet, income, "quarterly", 1)).toBe("Q3 FY27 is not in yet: only its EPS is on file (2.70 diluted), not its revenue.");
  });

  test("a missing June income quarter does not hide the September statement or advance a March TTM", () => {
    const financials = createTestFinancials({
      annualStatements: [{ date: "2025-12-31", totalRevenue: 3481.9e6, totalAssets: 10_301.282e6, currency: "CAD" }],
      quarterlyStatements: [
        { date: "2025-06-30", totalRevenue: 877.016e6, currency: "CAD" },
        { date: "2025-09-30", totalRevenue: 614.555e6, currency: "CAD" },
        { date: "2025-12-31", totalRevenue: 1200.93e6, currency: "CAD" },
        { date: "2026-03-31", totalRevenue: 845.365e6, currency: "CAD" },
        { date: "2026-09-30", totalRevenue: 619.064e6, totalAssets: 10_377.586e6, currency: "CAD" },
      ],
    });
    expect(buildFinancialTableModel(financials, { period: "annual", statement: "income" })?.statements[0]).toMatchObject({
      aggregation: { periodEnd: "2026-03-31" },
    });
    expect(buildFinancialTableModel(financials, { period: "quarterly", statement: "income" })?.statements[0]).toMatchObject({
      date: "2026-09-30", totalRevenue: 619.064e6,
    });
    expect(buildFinancialTableModel(financials, { period: "annual", statement: "balance" })?.statements[0]).toMatchObject({
      date: "2026-09-30", totalAssets: 10_377.586e6,
    });
  });

  test("the ratio tabs read the same periods: the TTM to Q2 FY27, its opening a year before it", () => {
    const profitability = RATIO_TABS.find((tab) => tab.key === "profitability")!;
    const yearly = ratioTableForFinancials(financials, profitability, "annual");
    expect(yearly.periods.map(({ statement }) => statement.date)).toEqual(["TTM", "2026-01-25", "2025-01-26"]);
    expect(yearly.periods[0]!.opening?.date).toBe("2025-07-27");
    expect(yearly.cells.get(profitability.ratios[0]!.id)![0]!.value).toEqual(expect.any(Number));
    const ttm = yearly.periods[0]!.statement;
    expect(ratioOpenings("annual", annual, quarterly, ttm).get("TTM")?.date).toBe("2025-07-27");
    // Without the TTM, the quarter a year before the latest on file, as before.
    expect(ratioOpenings("annual", annual, quarterly).get("TTM")?.date).toBe("2025-10-26");
    const quarters = ratioTableForFinancials(financials, profitability, "quarterly");
    expect(quarters.periods[0]!.statement.date).toBe("2026-07-26");
    expect(quarters.notInYet?.map(({ date }) => date)).toEqual(["2026-10-31"]);
  });

  test("a TTM ending before the latest year is no column, and neither is one with nothing on the statement", () => {
    // Air Products on 2026-11-24: FY2026 filed in its 10-K, its fiscal Q4 with only its EPS.
    const quarters: FinancialStatement[] = [
      ...["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"].map((date) => ({ date, totalRevenue: 3e9, netIncome: 0.6e9, operatingCashFlow: 1e9 })),
      { date: "2026-09-30", eps: 3.1 },
    ];
    const years: FinancialStatement[] = [
      { date: "2025-09-30", totalRevenue: 12e9, netIncome: 2.4e9, operatingCashFlow: 3.6e9 },
      { date: "2026-09-30", totalRevenue: 12.1e9, netIncome: 2.5e9, operatingCashFlow: 3.7e9 },
    ];
    expect(selectFinancialStatements("annual", "income", years, quarters).statements.map(({ date }) => date)).toEqual(["2026-09-30", "2025-09-30"]);
    // Quarters with income lines only: four of them sum to no cash flow, and the TTM is not shown on Cash Flow.
    const incomeOnly = quarters.slice(0, 4).map(({ date, totalRevenue }) => ({ date, totalRevenue }));
    const earlier = [{ ...years[0]!, date: "2023-09-30" }, { ...years[1]!, date: "2024-09-30" }];
    expect(selectFinancialStatements("annual", "income", earlier, incomeOnly).statements[0]!.date).toBe("TTM");
    expect(selectFinancialStatements("annual", "cashflow", earlier, incomeOnly).statements.map(({ date }) => date)).toEqual(["2024-09-30", "2023-09-30"]);
  });
});
