import { describe, expect, test } from "bun:test";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import type { FinancialStatement, TickerFinancials } from "../../../types/financials";
import { dcfValue, FORECAST_YEARS, projectReverseDcf, solveImpliedGrowth } from "./model";

const financials = (fundamentals: TickerFinancials["fundamentals"], annual: Partial<FinancialStatement>[] = []): TickerFinancials =>
  ({ fundamentals, annualStatements: annual as FinancialStatement[], quarterlyStatements: [], priceHistory: [] });

describe("reverse DCF", () => {
  test("solves back the growth a value was built from, and says which side of the range a price falls outside", () => {
    for (const growth of [-0.2, 0, 0.08, 0.35]) {
      const value = dcfValue(100, growth, 0.09, 0.025);
      const implied = solveImpliedGrowth(value, 100, 0.09, 0.025);
      expect(implied?.kind).toBe("rate");
      expect(implied?.kind === "rate" ? implied.value : NaN).toBeCloseTo(growth, 8);
    }
    expect(solveImpliedGrowth(1, 100, 0.09, 0.025)).toEqual({ kind: "below" });
    expect(solveImpliedGrowth(1e15, 100, 0.09, 0.025)).toEqual({ kind: "above" });
    expect(solveImpliedGrowth(1000, -5, 0.09, 0.025)).toBeNull();
  });

  test("needs positive cash flow in the currency of the market value, and grows past FCF only between positive years", () => {
    const fundamentals = { enterpriseValue: 2000, freeCashFlow: 100, financialCurrency: "USD", marketCapCurrency: "USD" };
    const model = projectReverseDcf(financials(fundamentals, [
      { date: "2025-12-31", freeCashFlow: 100 }, { date: "2021-12-31", freeCashFlow: 50 }, { date: "2023-12-31", freeCashFlow: -10 },
    ]), { symbol: "X", discountRate: 0.09 });
    expect(model.error).toBeNull();
    expect(model.fcfYield).toBe(0.05);
    expect(model.pastGrowth?.years).toBe(4);
    expect(model.pastGrowth?.rate).toBeCloseTo(2 ** 0.25 - 1, 10);
    expect(model.sensitivity.map((row) => row.implied.length)).toEqual([3, 3, 3, 3, 3, 3]);

    expect(projectReverseDcf(financials(fundamentals, [{ date: "2021-12-31", freeCashFlow: -50 }, { date: "2025-12-31", freeCashFlow: 100 }]),
      { symbol: "X", discountRate: 0.09 }).pastGrowth).toBeNull();
    expect(projectReverseDcf(financials({ ...fundamentals, financialCurrency: "TWD" }), { symbol: "X", discountRate: 0.09 }).error)
      .toBe("Cash flows are in TWD and the market value in USD.");
    expect(projectReverseDcf(financials({ ...fundamentals, freeCashFlow: -1 }), { symbol: "X", discountRate: 0.09 }).implied).toBeNull();
  });

  test("reads the EV valuation shows: at the regular close, labelled against market cap + debt - cash, unavailable when withdrawn", () => {
    // After hours: printed 210 after a 200 close; the cap, the EV and its check were measured at the print.
    const quote = { ...sessionQuotes("TEST", { listingExchangeName: "NYSE" }).weekend, price: 210, regularClose: 200 };
    const check = { status: "differs" as const, source: 1_900, currency: "USD", marketCap: 2_100, totalDebt: 100, cash: 50, computed: 2_150 };
    const fundamentals = { enterpriseValue: 1_900, enterpriseValueCheck: check, marketCap: 2_100, sharesOutstanding: 10, trailingPE: 21, eps: 10,
      freeCashFlow: 100, financialCurrency: "USD", marketCapCurrency: "USD" };
    const model = projectReverseDcf({ ...financials(fundamentals), quote }, { symbol: "X", discountRate: 0.09, fcfMargin: 0.25 });
    // Only the equity part moves: 100 off the cap, so 1,800 against 2,050 computed, and the growth is solved at 1,800.
    expect(model).toMatchObject({ enterpriseValue: 1_800, computedEnterpriseValue: 2_050, error: null,
      implied: solveImpliedGrowth(1_800, 100, 0.09, 0.025) });
    expect(model.enterpriseValueNote).toContain("(provider)");
    const growth = model.implied?.kind === "rate" ? model.implied.value : NaN;
    expect(model.impliedRevenue).toBeCloseTo(100 * (1 + growth) ** FORECAST_YEARS / 0.25, 6);

    const withdrawn = { ...fundamentals, enterpriseValue: undefined, unavailableFields: ["enterpriseValue" as const],
      enterpriseValueCheck: { ...check, status: "withdrawn" as const, source: 6_000 } };
    const unavailable = projectReverseDcf({ ...financials(withdrawn), quote }, { symbol: "X", discountRate: 0.09 });
    expect(unavailable).toMatchObject({ enterpriseValue: null, implied: null, impliedRevenue: null });
    expect(unavailable.error).toStartWith("EV unavailable: the provider's");
  });
});
