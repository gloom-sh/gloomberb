import { describe, expect, test } from "bun:test";
import type { FinancialStatement, PricePoint } from "../../../../types/financials";
import type { AssetDataProvider } from "../../../../types/data-provider";
import { createTestFinancials } from "../../../../test-support/data-provider";
import { loadPeriodEndHistory } from "./period-end-history";
import {
  RATIO_TABS,
  evaluateRatio,
  periodEndClose,
  ratioTableForFinancials,
  resolveFinancialSectionKey,
  type RatioDef,
  type RatioPeriod,
} from "./ratios";

const ratio = (id: string): RatioDef => RATIO_TABS.flatMap((tab) => tab.ratios).find((def) => def.id === id)!;

function period(statement: FinancialStatement, opening?: FinancialStatement, extra: Partial<RatioPeriod> = {}): RatioPeriod {
  return { statement, opening, quarterly: false, price: "no-price", ...extra };
}

const day = (date: string, close: number): PricePoint => ({ date: new Date(`${date}T13:30:00Z`), close });

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
    expect(evaluateRatio(ratio("pe"), period(statement, undefined, { price: 20, quarterly: true })).value).toBe(2.5);
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

  test("ratio tab options resolve by key, name and alias", () => {
    expect(resolveFinancialSectionKey("valuation")).toBe("valuation");
    expect(resolveFinancialSectionKey("Leverage")).toBe("leverage");
    expect(resolveFinancialSectionKey("working capital")).toBe("efficiency");
    expect(resolveFinancialSectionKey("ratios")).toBe("profitability");
    expect(resolveFinancialSectionKey("bs")).toBe("balance");
    expect(resolveFinancialSectionKey("unknown")).toBe("income");
  });
});
