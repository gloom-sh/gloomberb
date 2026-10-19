import { describe, expect, test } from "bun:test";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import type { FinancialStatement, TickerFinancials } from "../../../types/financials";
import { DEFAULT_FCF_MARGIN, dcfValue, describeFcfMargin, FORECAST_YEARS, projectReverseDcf, solveImpliedGrowth } from "./model";

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

describe("the margin behind the implied year-10 revenue", () => {
  const model = (fundamentals: Partial<NonNullable<TickerFinancials["fundamentals"]>>, fcfMargin?: number) =>
    projectReverseDcf(financials({ enterpriseValue: 2_000, financialCurrency: "USD", marketCapCurrency: "USD", ...fundamentals }),
      { symbol: "X", discountRate: 0.09, fcfMargin });
  const grown = (base: number, m: ReturnType<typeof model>) => base * (1 + (m.implied?.kind === "rate" ? m.implied.value : NaN)) ** FORECAST_YEARS;

  test("is the company's own trailing margin, so a high converter needs far less revenue than a thin one", () => {
    const high = model({ revenue: 230, freeCashFlow: 127 });
    expect(high.fcfMargin).toBeCloseTo(127 / 230, 12);
    expect(high.fcfMarginBasis).toEqual({ source: "company", company: 127 / 230, gap: null });
    // The year-10 revenue is the trailing revenue grown at the implied rate: no margin guess in between.
    expect(high.impliedRevenue).toBeCloseTo(grown(230, high), 6);
    expect(describeFcfMargin(high.fcfMargin, high.fcfMarginBasis)).toBe("55.2% FCF margin (company TTM)");

    const thin = model({ revenue: 700, freeCashFlow: 21 });
    expect(thin.fcfMargin).toBeCloseTo(0.03, 12);
    expect(thin.impliedRevenue).toBeCloseTo(grown(700, thin), 6);
    expect(thin.impliedRevenue! / grown(21, thin)).toBeCloseTo(1 / 0.03, 8);
    expect(describeFcfMargin(thin.fcfMargin, thin.fcfMarginBasis)).toBe("3% FCF margin (company TTM)");
  });

  test("a chosen margin overrides it and still names the company's", () => {
    const chosen = model({ revenue: 230, freeCashFlow: 127 }, 0.25);
    expect(chosen.fcfMargin).toBe(0.25);
    expect(chosen.fcfMarginBasis).toMatchObject({ source: "chosen", company: 127 / 230 });
    expect(chosen.impliedRevenue).toBeCloseTo(grown(127, chosen) / 0.25, 6);
    expect(describeFcfMargin(chosen.fcfMargin, chosen.fcfMarginBasis)).toBe("25% FCF margin (chosen; company TTM 55.2%)");
    expect(describeFcfMargin(0.25, { source: "chosen", company: null, gap: "no TTM revenue" })).toBe("25% FCF margin (chosen)");
  });

  test("falls back to the stated default, and says why, when revenue is missing or the margin means nothing", () => {
    const missing = model({ freeCashFlow: 100 });
    expect(missing.fcfMargin).toBe(DEFAULT_FCF_MARGIN);
    expect(missing.fcfMarginBasis).toEqual({ source: "default", company: null, gap: "no TTM revenue" });
    expect(missing.impliedRevenue).toBeCloseTo(grown(100, missing) / DEFAULT_FCF_MARGIN, 6);
    expect(describeFcfMargin(missing.fcfMargin, missing.fcfMarginBasis)).toBe("30% FCF margin (default; no TTM revenue)");

    // A free cash flow of zero or below is no margin: the pane's error stands, and the margin is the default.
    const negative = model({ revenue: 500, freeCashFlow: -40 });
    expect(negative.error).toContain("negative");
    expect(negative).toMatchObject({ impliedRevenue: null, fcfMargin: DEFAULT_FCF_MARGIN,
      fcfMarginBasis: { source: "default", company: null, gap: "TTM FCF not positive" } });

    expect(model({ revenue: -500, freeCashFlow: 40 }).fcfMarginBasis.gap).toBe("TTM revenue not positive");
    expect(model({ revenue: 30, freeCashFlow: 40 })).toMatchObject({ fcfMargin: DEFAULT_FCF_MARGIN, fcfMarginBasis: { gap: "TTM FCF above revenue" } });
  });
});
