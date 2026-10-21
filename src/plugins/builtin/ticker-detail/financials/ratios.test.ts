import { describe, expect, test } from "bun:test";
import type { FinancialStatement, PricePoint } from "../../../../types/financials";
import type { AssetDataProvider } from "../../../../types/data-provider";
import { createTestFinancials, createTestQuote } from "../../../../test-support/data-provider";
import type { SecEpsBasis } from "../../../../utils/sec-eps-basis";
import { cashRunway } from "../../../../utils/cash-runway";
import { FINANCIAL_LABEL_W } from "./model";
import { loadPeriodEndHistory } from "./period-end-history";
import {
  RATIO_TABS,
  evaluateRatio,
  periodEndClose,
  ratioPeriodEnd,
  ratioTableForFinancials,
  resolveFinancialSectionKey,
  type RatioAmount,
  type RatioDef,
  type RatioPeriod,
} from "./ratios";

const ratio = (id: string): RatioDef => RATIO_TABS.flatMap((tab) => tab.ratios).find((def) => def.id === id)!;

function period(statement: FinancialStatement, opening?: FinancialStatement, extra: Partial<RatioPeriod> = {}): RatioPeriod {
  return { statement, opening, quarterly: false, price: "no-price", ...extra };
}

const day = (date: string, close: number): PricePoint => ({ date: new Date(`${date}T13:30:00Z`), close });

/**
 * Fiscal years from the statements (USD) and the boundaries of the near-zero
 * equity rule: name, net income, opening and closing equity, and the ROE
 * percent shown, or null for N/M. No case carries total assets; the rule never
 * reads them. The screener's Annual ROE runs the same cases in the platform's
 * equity-screener research.test.ts; keep the two lists identical.
 */
const ROE_CASES: [string, number, number, number, number | null][] = [
  ["AbbVie FY2025, equity turns negative", 4_226e6, 3_325e6, -3_270e6, null],
  ["Boeing FY2025, equity turns positive", 2_235e6, -3_908e6, 5_454e6, null],
  ["Seagate FY2026, equity turns positive", 3_184e6, -453e6, 2_167e6, null],
  ["McDonald's FY2025, negative both ends", 8_563e6, -3_796e6, -1_790e6, null],
  ["Colgate FY2025, 1,603%", 2_132e6, 212e6, 54e6, null],
  ["Home Depot FY2023, 1,162%", 15_143e6, 1_562e6, 1_044e6, null],
  ["Home Depot FY2024", 14_806e6, 1_044e6, 6_640e6, 385.4],
  ["Apple FY2025", 112_010e6, 56_950e6, 73_733e6, 171.4],
  // Equity is 1.3% of its 3.2tn total assets: leverage alone is no reason.
  ["Freddie Mac FY2023", 10_538e6, 37_018e6, 47_722e6, 24.9],
  ["just under +500%", 499, 100, 100, 499],
  ["just over +500%", 501, 100, 100, null],
  ["a loss just under -500%", -499, 100, 100, -499],
  ["a loss just over -500%", -501, 100, 100, null],
  ["zero equity at the opening", 10, 0, 200, null],
];

describe("financial ratios", () => {
  test("return ratios divide by the average of the opening and closing balance, annualizing a quarter", () => {
    const opening = { date: "2025-03-31", totalEquity: 80, totalAssets: 300 };
    const closing = { date: "2025-06-30", netIncome: 5, totalEquity: 120, totalAssets: 500 };
    expect(evaluateRatio(ratio("roe"), period(closing, opening))).toEqual({ value: 0.05, inputs: [5, 100] });
    // A quarter's income counts four times; its inputs stay as reported.
    expect(evaluateRatio(ratio("roe"), period(closing, opening, { quarterly: true }))).toEqual({ value: 0.2, inputs: [5, 100] });
    expect(evaluateRatio(ratio("roa"), period(closing, opening, { quarterly: true })).value).toBeCloseTo(0.05);
    // Both ends must use one definition: common equity at one end and total at the other is not an average.
    expect(evaluateRatio(ratio("roe"), period(closing, { date: "2025-03-31", commonStockEquity: 80 })).value).toBe("not-reported");
    expect(evaluateRatio(ratio("roe"), period(closing)).value).toBe("not-reported");
  });

  test("ROE reads N/M when equity changes sign or is under a fifth of net income, keeping its inputs", () => {
    for (const [name, netIncome, opening, closing, roe] of ROE_CASES) {
      const cell = evaluateRatio(ratio("roe"), period(
        { date: "2025-12-31", netIncome, totalEquity: closing },
        { date: "2024-12-31", totalEquity: opening },
      ));
      // The input rows still show the numbers behind an N/M.
      expect(cell.inputs, name).toEqual([netIncome, (opening + closing) / 2]);
      if (roe === null) expect(cell.value, name).toBe("not-meaningful");
      else expect((cell.value as number) * 100, name).toBeCloseTo(roe, 1);
    }
    // The cap applies to the annualized return: a quarter's 130 on 100 is 520% a year.
    const quarter = (netIncome: number) => evaluateRatio(ratio("roe"), period(
      { date: "2025-06-30", netIncome, totalEquity: 100 },
      { date: "2025-03-31", totalEquity: 100 },
      { quarterly: true },
    ));
    expect(quarter(130)).toEqual({ value: "not-meaningful", inputs: [130, 100] });
    expect(quarter(120).value).toBeCloseTo(4.8);
    // The rule reads the same line at both ends: common equity when total equity is missing at one.
    expect(evaluateRatio(ratio("roe"), period(
      { date: "2025-12-31", netIncome: 30, totalEquity: 140, commonStockEquity: -10 },
      { date: "2024-12-31", commonStockEquity: 60 },
    )).value).toBe("not-meaningful");
  });

  test("working-capital days spread the flow per day and the cycle nets them", () => {
    const opening = { date: "2024-12-31", accountsReceivable: 30, inventory: 20, accountsPayable: 50 };
    const closing = { date: "2025-12-31", totalRevenue: 365, costOfRevenue: 182.5, accountsReceivable: 50, inventory: 30, accountsPayable: 70 };
    expect(evaluateRatio(ratio("dso"), period(closing, opening))).toEqual({ value: 40, inputs: [40, 1] });
    expect(evaluateRatio(ratio("dio"), period(closing, opening)).value).toBe(50);
    expect(evaluateRatio(ratio("dpo"), period(closing, opening)).value).toBe(120);
    expect(evaluateRatio(ratio("cash-conversion"), period(closing, opening))).toEqual({ value: -30, inputs: [40, 50, 120] });
    // A quarter spreads its revenue over a quarter of the year.
    expect(evaluateRatio(ratio("dso"), period(closing, opening, { quarterly: true })).value).toBe(10);
  });

  test("valuation uses the period-end close, period-end shares and net debt", () => {
    const statement = {
      date: "2025-12-31", eps: 2, ordinarySharesNumber: 10, totalDebt: 30, cashCashEquivalentsAndShortTermInvestments: 10,
      ebitda: 12, totalRevenue: 50, totalEquity: 40, freeCashFlow: 5,
    };
    const priced = period(statement, undefined, { price: 20 });
    expect(evaluateRatio(ratio("pe"), priced).value).toBe(10);
    expect(evaluateRatio(ratio("ev-ebitda"), priced)).toEqual({ value: 220 / 12, inputs: [220, 12] });
    expect(evaluateRatio(ratio("pb"), priced).value).toBe(5);
    expect(evaluateRatio(ratio("fcf-yield"), priced).value).toBe(0.025);
    // A quarterly column reads its trailing year, never the quarter's EPS times four.
    const quarter = { price: 20, quarterly: true };
    expect(evaluateRatio(ratio("pe"), period(statement, undefined, { ...quarter, trailing: { ...statement, eps: 4 } })).value).toBe(5);
    expect(evaluateRatio(ratio("pe"), period(statement, undefined, { ...quarter, trailing: null })).value).toBe("short-history");
    expect(evaluateRatio(ratio("pe"), period(statement, undefined, { price: "loading" })).value).toBe("loading");
  });

  test("a missing line reads not reported and a meaningless denominator reads N/M, never zero", () => {
    // Filers such as Apple stopped tagging interest expense after FY2023.
    const untagged = evaluateRatio(ratio("interest-coverage"), period({ date: "2024-09-28", operatingIncome: 123 }));
    expect(untagged).toEqual({ value: "not-reported", inputs: [123, "not-reported"] });
    expect(evaluateRatio(ratio("net-debt-ebitda"), period({ date: "2024-12-31", totalDebt: 10, ebitda: 5 })).value).toBe("not-reported");
    expect(evaluateRatio(ratio("debt-equity"), period({ date: "2024-12-31", totalDebt: 10, totalEquity: -4 })).value).toBe("not-meaningful");
    expect(evaluateRatio(ratio("pe"), period({ date: "2024-12-31", eps: -1 }, undefined, { price: 10 })).value).toBe("not-meaningful");
    // A statement gap or an unresolved split basis withholds EPS rather than reading a stale value.
    expect(evaluateRatio(ratio("pe"), period({ date: "2024-12-31", eps: 3, unavailableEarnings: ["eps"] }, undefined, { price: 10 })).value)
      .toBe("not-reported");
    // A reported zero stays a value.
    expect(evaluateRatio(ratio("net-debt-ebitda"), period({ date: "2024-12-31", totalDebt: 0, cashAndCashEquivalents: 0, ebitda: 5 })).value)
      .toBe(0);
    // A missing input outranks a missing close: the filer's gap explains more.
    expect(evaluateRatio(ratio("ev-ebitda"), period({ date: "2024-12-31", ordinarySharesNumber: 1 }, undefined, { price: "no-price" })).value)
      .toBe("not-reported");
  });

  test("a period-end price is a daily close on or up to a week before the period end", () => {
    const history = [day("2025-06-20", 90), day("2025-06-27", 100), day("2025-06-30", 101), day("2025-07-01", 120)];
    expect(periodEndClose(history, "2025-06-29")).toBe(100);
    expect(periodEndClose(history, "2025-06-30")).toBe(101);
    expect(periodEndClose(history, "2025-06-19")).toBeUndefined();
    expect(periodEndClose([day("2025-06-01", 100)], "2025-06-30")).toBeUndefined();
  });

  test("weekly bars never price a period end", async () => {
    const weekly = ["2025-06-02", "2025-06-09", "2025-06-16", "2025-06-23"].map((date) => day(date, 100));
    const provider = { getPriceHistory: async () => weekly } as unknown as AssetDataProvider;
    await expect(loadPeriodEndHistory(provider, "MSFT", "", "2025-06-30", undefined, Date.parse("2025-09-01"))).rejects.toThrow();
  });

  test("report tables keep the pane's columns and open every ratio", () => {
    const financials = createTestFinancials({
      annualStatements: [
        { date: "2024-12-31", netIncome: 10, totalRevenue: 100, totalEquity: 40 },
        { date: "2025-12-31", netIncome: 12, totalRevenue: 120, totalEquity: 60 },
      ],
      quarterlyStatements: [],
    });
    const table = ratioTableForFinancials(financials, RATIO_TABS.find((tab) => tab.key === "profitability")!, "annual");
    expect(table.periods.map(({ statement }) => statement.date)).toEqual(["2025-12-31", "2024-12-31"]);
    expect(table.cells.get("roe")!.map((cell) => cell.value)).toEqual([0.24, "not-reported"]);
    expect(table.rows.filter((row) => row.kind === "input").length).toBe(12);
  });

  test("quarterly leverage divides by the trailing year, not a quarter times four, and says when four quarters are not on file", () => {
    // Newmont's EBITDA by quarter to June 2026, in bn; its FY2025 is reported too.
    const quarter = (date: string, ebitda: number) => ({
      date, ebitda, operatingIncome: ebitda / 2, interestExpense: 0.04, freeCashFlow: 2, totalRevenue: 6,
      totalDebt: 5.08, cashCashEquivalentsAndShortTermInvestments: 9.01,
    });
    const financials = createTestFinancials({
      annualStatements: [{ date: "2025-12-31", ebitda: 14.09, operatingIncome: 11.02, interestExpense: 0.229, freeCashFlow: 7.3, totalRevenue: 22 }],
      quarterlyStatements: [
        quarter("2025-06-30", 3.80), quarter("2025-09-30", 3.20), quarter("2025-12-31", 3.94),
        quarter("2026-03-31", 5.25), quarter("2026-06-30", 3.64),
      ],
    });
    const leverage = RATIO_TABS.find((tab) => tab.key === "leverage")!;
    const table = ratioTableForFinancials(financials, leverage, "quarterly");
    expect(table.periods.map(({ statement }) => statement.date)).toEqual(["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"]);
    const ebitda = table.cells.get("net-debt-ebitda")!.map((cell) => cell.inputs[1]);
    // Four quarters summed, then the fiscal year that ends with the quarter, then too few quarters.
    expect(ebitda[0]).toBeCloseTo(3.20 + 3.94 + 5.25 + 3.64);
    expect(ebitda[1]).toBeCloseTo(3.80 + 3.20 + 3.94 + 5.25);
    expect(ebitda.slice(2)).toEqual([14.09, "short-history", "short-history"]);
    expect(table.cells.get("net-debt-ebitda")![0]!.value).toBeCloseTo(-3.93 / 16.03);
    // Every leverage ratio that divides a flow reads it over the same year.
    expect(table.cells.get("interest-coverage")![0]!.value).toBeCloseTo(8.015 / 0.16);
    expect(table.cells.get("fcf-debt")!.map((cell) => cell.value)).toEqual([8 / 5.08, 8 / 5.08, 7.3 / 5.08, "short-history", "short-history"]);
    expect(table.rows.filter((row) => row.kind === "input").map((row) => row.label)).toEqual([
      "Net Debt", "÷ EBITDA TTM", "Total Debt", "÷ Equity", "EBIT TTM", "÷ Interest Exp TTM", "Free Cash Flow TTM", "÷ Total Debt",
    ]);
    // A year's column reads its own year, as before.
    const annual = ratioTableForFinancials(financials, leverage, "annual");
    expect(annual.rows.find((row) => row.id === "net-debt-ebitda:1")!.label).toBe("÷ EBITDA");
  });

  test("liquidity's runway reads the months ticker reads, at the quarter's burn and the trailing year's", () => {
    // A fiscal year to December, its last quarter's year on file, and an inflow quarter that turns the burn off.
    const quarter = (date: string, operatingCashFlow: number, cash: number): FinancialStatement => ({
      date, totalRevenue: 0, operatingCashFlow, cashCashEquivalentsAndShortTermInvestments: cash, currentLiabilities: 50,
    });
    const financials = createTestFinancials({
      annualStatements: [{ date: "2025-12-31", totalRevenue: 0, operatingCashFlow: -300, cashCashEquivalentsAndShortTermInvestments: 700 }],
      quarterlyStatements: [
        quarter("2025-09-30", -94, 715), quarter("2025-12-31", -85.3, 700), quarter("2026-03-31", 20, 603),
        quarter("2026-06-30", -125.17, 501.66),
      ],
    });
    const liquidity = RATIO_TABS.find((tab) => tab.key === "liquidity")!;
    const table = ratioTableForFinancials(financials, liquidity, "quarterly");
    const runway = cashRunway(financials)!;
    const months = (estimate: typeof runway.quarter): RatioAmount => estimate?.kind === "months" ? estimate.months : estimate?.kind ?? "not-reported";
    expect(table.cells.get("runway-quarter")!.map((cell) => cell.value)).toEqual([months(runway.quarter), "no-burn", 700 / (85.3 / 3), 715 / (94 / 3)]);
    expect(table.cells.get("runway-ttm")![0]!.value).toBe(months(runway.trailing));
    // The quarter ending with the fiscal year reads that year; one with fewer than four quarters says so.
    expect(table.cells.get("runway-ttm")!.slice(1).map((cell) => cell.value)).toEqual(["short-history", 700 / (300 / 12), "short-history"]);
    expect(table.rows.filter((row) => row.kind === "input" && row.def.format === "months").map((row) => row.label))
      .toEqual(["Cash + ST Inv", "\u00f7 Op Burn/Mo", "Cash + ST Inv", "\u00f7 Op Burn/Mo TTM"]);
    // A quarter missing the total reads not reported, not its cash alone, when other periods report it.
    const sparse = createTestFinancials({
      ...financials,
      quarterlyStatements: [{ date: "2025-09-30", totalRevenue: 0, operatingCashFlow: -94, cashAndCashEquivalents: 38 }, ...financials.quarterlyStatements.slice(1)],
    });
    expect(ratioTableForFinancials(sparse, liquidity, "quarterly").cells.get("runway-quarter")!.at(-1)!.value).toBe("not-reported");
    // Years have no quarter to read: the annual view keeps the trailing runway alone.
    const annual = ratioTableForFinancials(financials, liquidity, "annual");
    expect(annual.ratios.map((def) => def.id)).not.toContain("runway-quarter");
    expect(annual.cells.get("runway-ttm")!.map((cell) => cell.value)).toEqual([months(runway.trailing), 700 / (300 / 12)]);
  });

  describe("quarterly valuation reads the trailing year", () => {
    // Six quarters to June 2026 and the calendar FY2025, whose reported figures differ slightly from its quarters' sum.
    const quarter = (date: string, eps: number, ebitda: number, totalRevenue: number, freeCashFlow: number): FinancialStatement => ({
      date, currency: "USD", eps, ebitda, totalRevenue, freeCashFlow, ordinarySharesNumber: 10, totalDebt: 50, cashCashEquivalentsAndShortTermInvestments: 20,
    });
    const quarters = (overrides: Partial<Record<string, Partial<FinancialStatement>>> = {}) => [
      quarter("2025-03-31", 2.0, 20, 90, 4), quarter("2025-06-30", 2.5, 25, 95, 6), quarter("2025-09-30", 2.5, 25, 100, 8),
      quarter("2025-12-31", 3.0, 30, 105, 10), quarter("2026-03-31", 3.0, 30, 110, 12), quarter("2026-06-30", 3.5, 35, 115, 14),
    ].map((row) => ({ ...row, ...overrides[row.date] }));
    const build = (rows = quarters()) => createTestFinancials({
      quote: createTestQuote({ symbol: "TEST", currency: "USD" }),
      annualStatements: [{ date: "2025-12-31", currency: "USD", eps: 10.2, ebitda: 101, totalRevenue: 392, freeCashFlow: 30, ordinarySharesNumber: 10, totalDebt: 50, cashCashEquivalentsAndShortTermInvestments: 20 }],
      quarterlyStatements: rows,
    });
    const closes = [day("2025-12-31", 102), day("2026-03-31", 110), day("2026-06-30", 120)];
    const valuation = RATIO_TABS.find((tab) => tab.key === "valuation")!;
    const IDS = ["pe", "ev-ebitda", "ps", "fcf-yield"] as const;
    const columns = (table: ReturnType<typeof ratioTableForFinancials>) => table.periods.map(({ statement }) => statement.date);

    test("a mid-year quarter sums four quarters, a fiscal year end reads the year, and a short history says so", () => {
      const table = ratioTableForFinancials(build(), valuation, "quarterly", closes);
      expect(columns(table)).toEqual(["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31"]);
      const cells = (id: string) => table.cells.get(id)!;
      // Q3 2025 to Q2 2026 summed: EPS 12, EBITDA 120, revenue 430, free cash flow 44; market cap 1,200 and EV 1,230.
      expect(cells("pe")[0]).toEqual({ value: 10, inputs: [120, 12] });
      expect(cells("ev-ebitda")[0]).toEqual({ value: 1230 / 120, inputs: [1230, 120] });
      expect(cells("ps")[0]).toEqual({ value: 1200 / 430, inputs: [1200, 430] });
      expect(cells("fcf-yield")[0]).toEqual({ value: 44 / 1200, inputs: [44, 1200] });
      // Q2 2025 to Q1 2026.
      expect(cells("pe")[1]!.inputs[1]).toBe(11);
      expect(cells("ev-ebitda")[1]!.inputs[1]).toBe(110);
      // The fiscal year that ends with the quarter, as reported, not the sum of its quarters (10, 100, 390, 28).
      expect(cells("pe")[2]).toEqual({ value: 102 / 10.2, inputs: [102, 10.2] });
      expect(cells("ev-ebitda")[2]!.inputs[1]).toBe(101);
      expect(cells("ps")[2]!.inputs[1]).toBe(392);
      expect(cells("fcf-yield")[2]!.inputs[0]).toBe(30);
      // Three quarters on file to September 2025 and one to March 2025: no year to read, and no annualizing.
      for (const id of IDS) expect(cells(id).slice(3).map((cell) => cell.value), id).toEqual(["short-history", "short-history", "short-history"]);
      expect(cells("pe")[3]!.inputs[1]).toBe("short-history");
    });

    test("the input rows say TTM, and a year's column keeps its plain labels", () => {
      const labels = (table: ReturnType<typeof ratioTableForFinancials>) => table.rows.filter((row) => row.kind === "input").map((row) => row.label);
      expect(labels(ratioTableForFinancials(build(), valuation, "quarterly", closes))).toEqual([
        "Price", "÷ Diluted EPS TTM", "Enterprise Value", "÷ EBITDA TTM", "Market Cap", "÷ Revenue TTM",
        "Market Cap", "÷ Equity", "Free Cash Flow TTM", "÷ Market Cap",
      ]);
      expect(labels(ratioTableForFinancials(build(), valuation, "annual", closes))).toEqual([
        "Price", "÷ Diluted EPS", "Enterprise Value", "÷ EBITDA", "Market Cap", "÷ Revenue",
        "Market Cap", "÷ Equity", "Free Cash Flow", "÷ Market Cap",
      ]);
      // Each label leaves room for its indent and a unit (" (mn)") in the label column.
      for (const label of labels(ratioTableForFinancials(build(), valuation, "quarterly", closes))) {
        expect(label.length + "    ".length + " (mn)".length, label).toBeLessThanOrEqual(FINANCIAL_LABEL_W);
      }
    });

    test("a quarter's TTM ratios match the annual view's TTM column for the same quarter end", () => {
      const quarterly = ratioTableForFinancials(build(), valuation, "quarterly", closes);
      const annual = ratioTableForFinancials(build(), valuation, "annual", closes);
      expect(annual.periods[0]!.statement.date).toBe("TTM");
      expect(ratioPeriodEnd(annual.periods[0]!.statement)).toBe("2026-06-30");
      for (const id of IDS) expect(annual.cells.get(id)![0], id).toEqual(quarterly.cells.get(id)![0]!);
    });

    test("EPS from a quarter with a gap or an unresolved basis reads not reported in both views", () => {
      const unresolved: SecEpsBasis = { status: "unresolved", source: "sec", originalValue: 3.5, basisDate: "2026-06-30", evidence: [] };
      for (const withheld of [{ epsBasis: unresolved }, { unavailableEarnings: ["eps" as const] }]) {
        // The quarter still carries a number: the trailing sum must not include it.
        const financials = build(quarters({ "2026-06-30": withheld }));
        const quarterly = ratioTableForFinancials(financials, valuation, "quarterly", closes);
        const annual = ratioTableForFinancials(financials, valuation, "annual", closes);
        expect(quarterly.cells.get("pe")![0], JSON.stringify(withheld)).toEqual({ value: "not-reported", inputs: [120, "not-reported"] });
        expect(annual.cells.get("pe")![0]).toEqual(quarterly.cells.get("pe")![0]!);
        // Windows that do not include the quarter, and the other ratios, are untouched.
        expect(quarterly.cells.get("pe")![1]!.value).toBe(10);
        expect(quarterly.cells.get("ev-ebitda")![0]!.value).toBe(1230 / 120);
      }
    });

    test("a loss or a negative enterprise value over the trailing year stays N/M", () => {
      const loss = ratioTableForFinancials(build(quarters({ "2026-06-30": { eps: -20, ebitda: -200, freeCashFlow: -50 } })), valuation, "quarterly", closes);
      expect(loss.cells.get("pe")![0]!.value).toBe("not-meaningful");
      expect(loss.cells.get("ev-ebitda")![0]!.value).toBe("not-meaningful");
      expect(loss.cells.get("fcf-yield")![0]!.value).toBeCloseTo(-20 / 1200);
      const negativeEv = ratioTableForFinancials(build(quarters({ "2026-06-30": { totalDebt: 0 } })), valuation, "quarterly", [day("2026-06-30", 1)]);
      expect(negativeEv.cells.get("ev-ebitda")![0]).toEqual({ value: "not-meaningful", inputs: [-10, 120] });
    });

    test("a missing price keeps its place behind a missing trailing year", () => {
      const noClose = ratioTableForFinancials(build(), valuation, "quarterly", []);
      expect(noClose.cells.get("pe")!.map((cell) => cell.value)).toEqual(["no-price", "no-price", "no-price", "short-history", "short-history", "short-history"]);
    });
  });

  test("ratio tab options resolve by key, name and alias", () => {
    expect(resolveFinancialSectionKey("valuation")).toBe("valuation");
    expect(resolveFinancialSectionKey("Leverage")).toBe("leverage");
    expect(resolveFinancialSectionKey("working capital")).toBe("efficiency");
    expect(resolveFinancialSectionKey("ratios")).toBe("profitability");
    expect(resolveFinancialSectionKey("bs")).toBe("balance");
    expect(resolveFinancialSectionKey("unknown")).toBe("income");
  });
});
