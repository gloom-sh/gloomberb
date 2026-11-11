import { describe, expect, test } from "bun:test";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import { balanceSheetRateWanted, listingEnterpriseValue } from "../../../market-data/quotes/listing-enterprise-value";
import type { FinancialStatement, TickerFinancials } from "../../../types/financials";
import { matchExchangeResults, type ExchangeResults } from "../../../utils/exchange-results";
import { DEFAULT_FCF_MARGIN, dcfValue, describeFcfMargin, FORECAST_YEARS, missingInputsNote, pastGrowthBasis, projectReverseDcf, solveImpliedGrowth,
  ttmBaseNote } from "./model";

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

  test("reads the EV valuation shows: at the regular close, market cap + debt - cash in place of a provider EV off it, unavailable when withdrawn", () => {
    // After hours: printed 210 after a 200 close; the cap, the EV and its check were measured at the print.
    const quote = { ...sessionQuotes("TEST", { listingExchangeName: "NYSE" }).weekend, price: 210, regularClose: 200 };
    const check = { status: "differs" as const, source: 1_900, currency: "USD", marketCap: 2_100, totalDebt: 100, cash: 50, computed: 2_150 };
    const fundamentals = { enterpriseValue: 1_900, enterpriseValueCheck: check, marketCap: 2_100, sharesOutstanding: 10, trailingPE: 21, eps: 10,
      freeCashFlow: 100, financialCurrency: "USD", marketCapCurrency: "USD" };
    const model = projectReverseDcf({ ...financials(fundamentals), quote }, { symbol: "X", discountRate: 0.09, fcfMargin: 0.25 });
    // Only the equity part moves: 100 off the cap, so the provider's 1,800 against 2,050 computed; the growth is solved at 2,050.
    expect(model).toMatchObject({ enterpriseValue: 2_050, error: null, implied: solveImpliedGrowth(2_050, 100, 0.09, 0.025) });
    expect(model.enterpriseValueNote).toBe("EV 2k USD is market cap 2k + total debt 100 - cash 50, in place of the provider's 1.8k.");
    const growth = model.implied?.kind === "rate" ? model.implied.value : NaN;
    expect(model.impliedRevenue).toBeCloseTo(100 * (1 + growth) ** FORECAST_YEARS / 0.25, 6);

    const withdrawn = { ...fundamentals, enterpriseValue: undefined, unavailableFields: ["enterpriseValue" as const],
      enterpriseValueCheck: { ...check, status: "withdrawn" as const, source: 6_000 } };
    // At or below zero it is N/M with the reason, as valuation and RV say it.
    const reason = "Cash and short-term investments exceed market cap + total debt (balance sheet 2026-06-30)";
    const negative = projectReverseDcf({ ...financials({ ...withdrawn, enterpriseValueCheck: { ...check, status: "not-meaningful" as const,
      source: -85, computed: -99, reason } }), quote }, { symbol: "X", discountRate: 0.09 });
    expect(negative).toMatchObject({ enterpriseValue: null, implied: null,
      error: "EV N/M: cash and short-term investments exceed market cap + total debt (balance sheet 2026-06-30)." });
  });
});

describe("an EV the source withdrew", () => {
  const withdrawn = { enterpriseValue: undefined, unavailableFields: ["enterpriseValue" as const], marketCap: 195_000, freeCashFlow: 5_000,
    financialCurrency: "HKD", marketCapCurrency: "HKD" };
  // Pop Mart: CNY statements under an HKD cap, converted at our CNY/HKD close on the balance sheet's date.
  const rate = { from: "CNY", to: "HKD", date: "2026-06-30", rate: 1.2, closeDate: "2026-06-30" };
  const halfYears = (sheet: Partial<FinancialStatement>, extra: Partial<TickerFinancials> = {}): TickerFinancials => ({
    fundamentals: { ...withdrawn, ttmConversion: { from: "CNY", rate: 1.3, asOf: "2026-11-11" },
      enterpriseValueCheck: { status: "withdrawn", source: 104_900, currency: "HKD", convertedFrom: "CNY", reason: "Source EV is converted from CNY" } },
    annualStatements: [{ date: "2024-12-31", currency: "CNY", freeCashFlow: 4_400 }, { date: "2025-12-31", currency: "CNY" }] as FinancialStatement[],
    quarterlyStatements: [{ date: "2025-06-30", currency: "CNY", cashAndCashEquivalents: 11_900 },
      { date: "2026-06-30", currency: "CNY", capitalLeaseObligations: 3_700, ...sheet }] as FinancialStatement[],
    priceHistory: [], balanceSheetRate: rate, ...extra,
  });
  const run = (data: TickerFinancials, exchangeResults?: ExchangeResults) =>
    projectReverseDcf(data, { symbol: "9992:HKEX", discountRate: 0.09, exchangeResults });

  test("is market cap + debt - cash from the bridge Gloom Cloud served beside it, minority interest in", () => {
    const check = { status: "withdrawn" as const, source: 6_000, currency: "USD", marketCap: 2_000, totalDebt: 100, cash: 50, computed: 2_050,
      minorityAndPreferred: 30, balanceSheetDate: "2026-06-30", fx: { from: "EUR", rate: 1.1 } };
    const model = projectReverseDcf(financials({ enterpriseValue: undefined, unavailableFields: ["enterpriseValue"], enterpriseValueCheck: check,
      marketCap: 2_000, freeCashFlow: 100, financialCurrency: "USD", marketCapCurrency: "USD" }), { symbol: "X", discountRate: 0.09 });
    expect(model).toMatchObject({ enterpriseValue: 2_080, enterpriseValueSheet: "Jun 30, 2026", missing: [], error: null,
      implied: solveImpliedGrowth(2_080, 100, 0.09, 0.025) });
    expect(model.enterpriseValueNote).toContain("(balance sheet 2026-06-30, EUR/USD 1.1000 at its date's close)");
    // Its balance sheet is not among the statements here: its cash is called cash, and a minority interest it did not
    // serve is named as not added, never counted as zero.
    const { minorityAndPreferred: _, ...noMinority } = check;
    const unread = projectReverseDcf(financials({ enterpriseValue: undefined, unavailableFields: ["enterpriseValue"], enterpriseValueCheck: noMinority,
      marketCap: 2_000, freeCashFlow: 100, financialCurrency: "USD", marketCapCurrency: "USD" }), { symbol: "X", discountRate: 0.09 });
    expect(unread.enterpriseValue).toBe(2_050);
    expect(unread.enterpriseValueNote).toContain(" - cash 50 (balance sheet");
    expect(unread.enterpriseValueNote).toEndWith("; that balance sheet is not among the statements here, so its minority interest is not added.");
  });

  test("is built from the latest balance sheet at our close on its date, leases and minority interest in, dated by its results", () => {
    const results = matchExchangeResults("2026-06-30", [
      { date: "2026-08-20T08:30:00Z", headline: "INTERIM RESULTS", types: ["Interim Results"], priceSensitive: null, fileSize: null, documentKey: "1", url: "u" }])!;
    const model = run(halfYears({ totalDebt: 0, cashCashEquivalentsAndShortTermInvestments: 14_000,
      totalEquityGrossMinorityInterest: 23_300, commonStockEquity: 23_000 }), results);
    // 195,000 + (0 + 3,700 - 14,000 + 300) x 1.2 = 183,000, never at the trailing figures' 1.3
    expect(model).toMatchObject({ enterpriseValue: 183_000, enterpriseValueSheet: "Jun 30, 2026", missing: [], error: null });
    expect(model.enterpriseValueNote).toBe("EV 183k HKD is market cap 195k + total debt 0 + leases 4.4k - cash and short-term investments 16.8k"
      + " + minority interest and preferred equity 360 (balance sheet 2026-06-30, CNY/HKD 1.2000 at the 2026-06-30 close),"
      + " in place of the provider's 104.9k, which failed validation against it."
      + " Balance sheet from the interim results announced 2026-08-20 (HKEXnews).");
  });

  test("adds the market cap the reports show at the quote, not a cached snapshot's, whichever bridge it is", () => {
    // The snapshot was read at a 195,000 cap; the quote now prices 1,333 shares at 145: 193,285, the Market Cap `fundamentals` prints.
    const quote = { ...sessionQuotes("9992", { currency: "HKD", instrumentType: "EQUITY" }).regular, price: 145 };
    const sheet = { totalDebt: 0, cashCashEquivalentsAndShortTermInvestments: 14_000, totalEquityGrossMinorityInterest: 23_300, commonStockEquity: 23_000 };
    const live = (data: TickerFinancials): TickerFinancials => ({ ...data, quote, fundamentals: { ...data.fundamentals, sharesOutstanding: 1_333 } });
    // 193,285 + (0 + 3,700 - 14,000 + 300) x 1.2 = 181,285
    const read = listingEnterpriseValue(live(halfYears(sheet)));
    expect(read).toMatchObject({ kind: "value", value: 181_285, bridge: { marketCap: 193_285 } });
    // Gloom Cloud's bridge computed at its own read of the cap keeps its debt, cash and rate, and takes the same cap.
    const served = halfYears(sheet);
    served.fundamentals!.enterpriseValueCheck = { ...served.fundamentals!.enterpriseValueCheck!, marketCap: 195_000, totalDebt: 0, leases: 4_440,
      cash: 16_800, computed: 182_640, minorityAndPreferred: 360, balanceSheetDate: "2026-06-30", fx: { from: "CNY", rate: 1.2 } };
    expect(listingEnterpriseValue(live(served))).toMatchObject({ kind: "value", value: 181_285, bridge: { marketCap: 193_285 } });
    expect(run(live(halfYears(sheet))).enterpriseValueNote).toStartWith("EV 181.3k HKD is market cap 193.3k + ");
  });

  test("reads the borrowings from the debt-and-lease lines of a sheet with no total debt, and names cash alone and a missing minority line", () => {
    const model = run(halfYears({ longTermDebtAndCapitalLeaseObligation: 3_060, currentDebtAndCapitalLeaseObligation: 640, cashAndCashEquivalents: 14_000 }));
    // 195,000 + (0 + 3,700 - 14,000) x 1.2 = 182,640
    expect(model).toMatchObject({ enterpriseValue: 182_640, enterpriseValueSheet: "Jun 30, 2026", missing: [], error: null });
    expect(model.enterpriseValueNote).toContain(" - cash 16.8k (balance sheet");
    expect(model.enterpriseValueNote).toEndWith("; the balance sheet has no minority interest line, so none is added.");
    // Lines short of the leases they hold are not read as borrowings.
    expect(run(halfYears({ longTermDebtAndCapitalLeaseObligation: 1_000, currentDebtAndCapitalLeaseObligation: 640,
      cashCashEquivalentsAndShortTermInvestments: 14_000 })).missing[0]?.needs).toBe("total debt on the Jun 30, 2026 balance sheet");
  });

  test("refuses a sheet without our close on its date, one that states no currency, and one older than 550 days, saying why", () => {
    const sheet = { totalDebt: 0, cashCashEquivalentsAndShortTermInvestments: 14_000 };
    const needs = (data: TickerFinancials) => run(data).missing.map((item) => item.needs);
    expect(needs(halfYears(sheet, { balanceSheetRate: undefined }))).toEqual(["the CNY/HKD close on Jun 30, 2026"]);
    expect(balanceSheetRateWanted(halfYears(sheet, { balanceSheetRate: undefined }))).toEqual({ from: "CNY", to: "HKD", date: "2026-06-30" });
    expect(needs(halfYears({ ...sheet, currency: "" }))).toEqual(["the currency of the Jun 30, 2026 balance sheet, which states none"]);
    const old = halfYears(sheet);
    expect(projectReverseDcf(old, { symbol: "9992:HKEX", discountRate: 0.09 }).missing).toEqual([]);
    const later = Date.parse("2028-01-10T00:00:00Z");
    expect(listingEnterpriseValue(old, later)).toEqual({ kind: "unavailable",
      needs: "a balance sheet from the last 550 days; the latest is Jun 30, 2026" });
  });

  test("shows the EV beside a missing FCF, which names its latest statement and the results announcement that has the next", () => {
    const results = matchExchangeResults("2026-06-30", [
      { date: "2026-08-20T08:30:00Z", headline: "INTERIM RESULTS", types: ["Interim Results"], priceSensitive: null, fileSize: null, documentKey: "1", url: "u" }])!;
    const data = halfYears({ totalDebt: 0, cashCashEquivalentsAndShortTermInvestments: 14_000 });
    const model = run({ ...data, fundamentals: { ...data.fundamentals!, freeCashFlow: undefined } }, results);
    expect(model).toMatchObject({ enterpriseValue: 182_640, implied: null, error: null, missing: [{ input: "freeCashFlow", statement: "cashflow",
      needs: "a trailing figure; the latest cash flow statement is FY2024, and the half year to 2026-06-30 is in the interim results"
        + " announced 2026-08-20 (HKEXnews), its statements not in yet" }] });
  });

  test("prices a half-yearly reporter from the year-plus-half twelve months where served, else from its latest year, named", () => {
    const filled = { source: "results" as const, fields: [], documents: [], lines: {}, periodMonths: 6 };
    const base = halfYears({ totalDebt: 0, cashCashEquivalentsAndShortTermInvestments: 14_000, filledFrom: filled });
    const data: TickerFinancials = { ...base, fundamentals: { ...base.fundamentals!, freeCashFlow: undefined, revenue: 52_000 },
      annualStatements: [{ date: "2024-12-31", currency: "CNY", freeCashFlow: 4_400 }, { date: "2025-12-31", currency: "CNY", freeCashFlow: 9_700 }] as FinancialStatement[] };
    // Pop Mart after its interim results: FY2025 + H1 2026 - H1 2025, in CNY, at the trailing block's CNY/HKD 1.3.
    const trailingStatement = { date: "2026-06-30", currency: "CNY", freeCashFlow: 7_000, trailing: { method: "annual-plus-interim" as const,
      annual: "2025-12-31", interim: { end: "2026-06-30", months: 6 }, priorInterim: { end: "2025-06-30", months: 6 },
      basis: "FY to 2025-12-31 + 6 months to 2026-06-30 − 6 months to 2025-06-30" } };
    const trailing = run({ ...data, trailingStatement });
    expect(trailing).toMatchObject({ freeCashFlow: 9_100, missing: [], error: null, implied: solveImpliedGrowth(182_640, 9_100, 0.09, 0.025),
      freeCashFlowBasis: { kind: "trailing", label: "TTM H1 FY26", note: "Free cash flow TTM H1 FY26 is 7k CNY, 9.1k HKD at CNY/HKD 1.3000:"
        + " FY to 2025-12-31 + 6 months to 2026-06-30 − 6 months to 2025-06-30." },
      fcfMarginBasis: { source: "company", company: 9_100 / 52_000 } });
    // Without it, FY2025's figure, named as the year's; its margin is not taken for a trailing one.
    const year = run(data);
    expect(year).toMatchObject({ freeCashFlow: 12_610, missing: [], error: null, implied: solveImpliedGrowth(182_640, 12_610, 0.09, 0.025),
      freeCashFlowBasis: { kind: "fiscal-year", label: "FY2025", note: "Free cash flow is FY2025's, 9.7k CNY, 12.6k HKD at CNY/HKD 1.3000:"
        + " the company reports half-yearly and no trailing twelve months are served." },
      fcfMarginBasis: { source: "default", gap: "no TTM FCF" } });
    expect(ttmBaseNote(year)).toBeNull();
    // A quarterly reporter's missing trailing figure stays missing, never a year's; a filled half is named as one.
    const quarters = run({ ...data, annualStatements: [{ date: "2025-12-31", currency: "CNY" }] as FinancialStatement[],
      quarterlyStatements: [{ date: "2026-03-31", currency: "CNY" }, { ...base.quarterlyStatements[1]!, freeCashFlow: 2_900 }] });
    expect(quarters).toMatchObject({ freeCashFlow: null, freeCashFlowBasis: null,
      missing: [{ input: "freeCashFlow", needs: "a trailing figure; the latest cash flow statement is H1 FY26" }] });
  });

  test("names what the statements lack and where to read them, as a limit and not an error", () => {
    const model = run(halfYears({ cashCashEquivalentsAndShortTermInvestments: 14_000 }));
    expect(model).toMatchObject({ enterpriseValue: null, implied: null, error: null,
      missing: [{ input: "enterpriseValue", needs: "total debt on the Jun 30, 2026 balance sheet", statement: "balance" }] });
    const noFlow = run({ ...halfYears({ cashCashEquivalentsAndShortTermInvestments: 14_000 }),
      fundamentals: { ...halfYears({}).fundamentals!, freeCashFlow: undefined } });
    expect(noFlow.missing.map((item) => item.needs)).toEqual(["total debt on the Jun 30, 2026 balance sheet",
      "a trailing figure; the latest cash flow statement is FY2024"]);
    expect(missingInputsNote(noFlow.missing, "9992:HKEX")).toBe("Inputs on file: fn FA 9992:HKEX --statement balance; fn FA 9992:HKEX --statement cashflow");
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

describe("the periods behind the past growth and the trailing base", () => {
  const model = (freeCashFlow: number, annual: Partial<FinancialStatement>[]) => projectReverseDcf(
    financials({ enterpriseValue: 2_000, freeCashFlow, financialCurrency: "USD", marketCapCurrency: "USD" }, annual), { symbol: "KO", discountRate: 0.09 });
  const years = (...flows: number[]) => flows.map((freeCashFlow, index) => ({ date: `${2025 - (flows.length - 1 - index)}-12-31`, freeCashFlow }));

  test("names the fiscal years the rate runs between, as a calendar's issuers do, and the dates where a year is off it", () => {
    const ko = model(143, years(110, 90, 80, 60, 53));
    expect(ko.pastGrowth).toMatchObject({ years: 4, period: "FY2021–FY2025" });
    expect(pastGrowthBasis(ko.pastGrowth!)).toBe("a year, FY2021–FY2025");
    // A fiscal year that ends in July is named by the year it ends in, as the statements name it.
    const july = model(100, [{ date: "2022-07-30", freeCashFlow: 50 }, { date: "2026-07-25", freeCashFlow: 90 }]);
    expect(july.pastGrowth?.period).toBe("FY2022–FY2026");
    // A statement off the company's fiscal calendar (a transition period) puts both ends as dates.
    const off = model(100, [{ date: "2021-03-31", freeCashFlow: 50 }, { date: "2022-12-31", freeCashFlow: 60 }, { date: "2023-12-31", freeCashFlow: 70 }, { date: "2024-12-31", freeCashFlow: 80 }, { date: "2025-12-31", freeCashFlow: 90 }]);
    expect(off.pastGrowth?.period).toBe("2021-03-31 to 2025-12-31");
  });

  test("says the trailing base differs when it is more than 1.5 times the latest fiscal year's, and not at or under it", () => {
    const flows = years(110, 90, 80, 60, 53);
    expect(model(143, flows).fiscalYearFcf).toEqual({ value: 53, label: "FY2025" });
    expect(ttmBaseNote(model(143, flows))).toBe("The TTM base differs from FY2025: TTM FCF is 2.7x that year's 53 USD.");
    // 1.5 times is not more than 1.5 times.
    expect(ttmBaseNote(model(79.5, flows))).toBeNull();
    expect(ttmBaseNote(model(80, flows))).toBe("The TTM base differs from FY2025: TTM FCF is 1.5x that year's 53 USD.");
    // A year with no positive cash flow is no base to compare, and a model with no growth to say has no note.
    expect(ttmBaseNote(model(143, years(110, 90, 80, 60, -5)))).toBeNull();
    expect(ttmBaseNote(model(143, []))).toBeNull();
    expect(ttmBaseNote({ ...model(143, flows), error: "EV unavailable." })).toBeNull();
  });
});
