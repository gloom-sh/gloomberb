import { describe, expect, test } from "bun:test";
import type { CloudFinancialsPayload } from "../../../api-client/types/ticker-data";
import { mapCloudFinancials } from "../../../sources/gloomberb-cloud/normalizers";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { extractFundamentalSeries, valuationNotMeaningful } from "../../../time-series/fundamentals";
import type { EnterpriseValueCheck, FinancialStatement, TickerFinancials } from "../../../types/financials";
import type { HeadlessPaneContext } from "../../../types/headless";
import { extraColumnsBasis, normalizeExtraColumns, parseExtraColumns } from "./relative-valuation-columns";
import { relativeValuationHeadless } from "./relative-valuation-headless";
import { convertTargets } from "./relative-valuation-currency";

describe("RV --columns", () => {
  test("takes the report's own columns by their usual names and adds nothing for them", () => {
    // `--columns trailingPE` was refused, so the P/E RV already reports read as one it could not give.
    for (const value of ["trailingPE", "P/E", "pe, forwardPE", "fwdPE,marketCap", "evSales fcfYield"]) {
      expect(normalizeExtraColumns(value)).toBe("");
      expect(parseExtraColumns(normalizeExtraColumns(value))).toEqual([]);
    }
    expect(normalizeExtraColumns("trailingPE,target,P/E,si")).toBe("target,shortInterest");
  });

  test("an unknown field names the columns it can add and the ones the report always has", () => {
    expect(() => normalizeExtraColumns("trailingPE,pegRatio")).toThrow(
      'Unknown --columns field "pegRatio". Use any of: shortInterest, nextEarnings, target, grossMargin, evEbitda. '
        + "Last, Chg%, Mkt Cap, P/E, Fwd P/E, EV/S, FCF Yield, Quarter Revenue YoY and TTM Op Margin are always in the report.",
    );
  });

  test("the footer dates each added column by its cells: a June fiscal year beside December ones, never a retrieval time", () => {
    const rows = [
      { symbol: "DUOL", grossMarginPercent: 72.2, grossMarginAsOf: "2025-12-31", targetMean: 210, targetAsOf: "2026-10-23T11:00:00.000Z" },
      { symbol: "MSFT", grossMarginPercent: 68.8, grossMarginAsOf: "2026-06-30", shortInterestPercentFloat: 0.8, shortInterestAsOf: "2026-09-30" },
      { symbol: "LRN", grossMarginPercent: 39.1, grossMarginAsOf: "2026-06-30" },
      { symbol: "LHA:XETRA", grossMarginPercent: null, grossMarginAsOf: null },
    ];
    expect(extraColumnsBasis(["grossMargin", "target", "shortInterest"], rows)).toEqual([
      "Gross Margin: trailing twelve months to 2026-06-30 (DUOL 2025-12-31)",
      "Short % Float: settlement 2026-09-30",
    ]);
  });
});

/** Four quarters as Gloom Cloud serves them: operating income, D&A, and the provider's EBITDA line beside them. */
function quarters(currency: string, rows: ReadonlyArray<[date: string, operatingIncome: number, amortization: number, provider: number, revenue: number]>): FinancialStatement[] {
  return rows.map(([date, operatingIncome, depreciationAndAmortization, ebitda, totalRevenue], index) => ({
    date, currency, operatingIncome, depreciationAndAmortization, ebitda, totalRevenue, grossProfit: totalRevenue / 2,
    dilutedShares: 1e9, ...(index === rows.length - 1 ? { totalDebt: 50e9, cashAndCashEquivalents: 54e9 } : {}),
  }));
}

function listing(symbol: string, currency: string, price: number, statements: FinancialStatement[], fundamentals: CloudFinancialsPayload["fundamentals"], industry?: string): TickerFinancials {
  // An ADR's statements are in the company's currency, its quote and EV in dollars.
  const statementCurrency = statements[0]?.currency ?? currency;
  return mapCloudFinancials({
    annualStatements: [], quarterlyStatements: statements, priceHistory: [], financialCurrency: statementCurrency,
    quote: { symbol, price, change: 0, changePercent: 0, currency, lastUpdated: Date.parse("2026-11-06T21:00:00Z"), marketState: "CLOSED" },
    fundamentals: { financialCurrency: statementCurrency, marketCapCurrency: currency, ...fundamentals },
    ...industry ? { profile: { industry } } : {},
  } as unknown as CloudFinancialsPayload);
}

const withdrawn: EnterpriseValueCheck = {
  status: "withdrawn", source: 37.25e12, computed: 535.04e9, currency: "USD", marketCap: 547.25e9, totalDebt: 2e9, cash: 14.21e9, balanceSheetDate: "2026-09-30",
  fx: { from: "EUR", rate: 1.133 },
};

const ASML_QUARTERS = quarters("EUR", [
  ["2025-12-31", 3_431.1e6, 255.2e6, 3_686.3e6, 9_718.1e6], ["2026-03-31", 3_157.8e6, 259.4e6, 3_417.2e6, 8_766.9e6],
  ["2026-06-30", 3_456.1e6, 246.9e6, 3_703e6, 9_326.5e6], ["2026-09-30", 5_172.8e6, 262.9e6, 5_435.7e6, 11_662e6],
]);

/** A row without operating income, as an energy major's latest quarter is filed: pretax income, tax, net income and D&A. */
function withoutOperatingIncome(row: FinancialStatement, lines: Partial<FinancialStatement>): FinancialStatement {
  const { operatingIncome: _reported, ebitda: _provider, ...rest } = row;
  return { ...rest, ...lines };
}

// Intel's four quarters to 2026-09-26 as served (millions): the provider's EBITDA sums to 3,366, operating income plus D&A to 14,381.
const PEERS: Record<string, { financials: TickerFinancials; expected: number }> = {
  INTC: {
    financials: listing("INTC", "USD", 56.28, quarters("USD", [
      ["2025-12-27", 580e6, 3_027e6, 3_648e6, 13_674e6], ["2026-03-28", -3_136e6, 3_136e6, -546e6, 12_667e6],
      ["2026-06-27", 1_796e6, 3_224e6, -7_274e6, 12_854e6], ["2026-09-26", 2_522e6, 3_232e6, 7_538e6, 16_513e6],
    ]), {
      marketCap: 299.13e9, enterpriseValue: 319.55e9, revenue: 55.7e9,
      enterpriseValueCheck: { status: "differs", source: 319.55e9, computed: 295.26e9, currency: "USD", marketCap: 299.13e9, balanceSheetDate: "2026-09-26" },
    }),
    expected: 319.55e9 / 14_381e6,
  },
  // A listing abroad reads its own statements, in its own currency.
  "ASML:AMS": {
    financials: listing("ASML", "EUR", 1_283.6, ASML_QUARTERS, { marketCap: 494.72e9, enterpriseValue: 480.98e9, revenue: 39.47e9 }),
    expected: 480.98e9 / (15_217.8e6 + 1_024.4e6),
  },
  // The ADR: a provider EV Gloom Cloud withdrew, so the market cap + total debt - cash it was checked against stands in,
  // over the same EUR statements at the rate the check converted the balance sheet at, on both surfaces.
  ASML: {
    financials: listing("ASML", "USD", 1_424.75, ASML_QUARTERS,
      { marketCap: 547.25e9, unavailableFields: ["enterpriseValue", "enterpriseToRevenue"], enterpriseValueCheck: withdrawn, revenue: 39.47e9 }),
    expected: 535.04e9 / ((15_217.8e6 + 1_024.4e6) * 1.133),
  },
  // Exxon Mobil's latest quarter files no operating income: pretax income stands in, and the source says so.
  XOM: {
    financials: listing("XOM", "USD", 165.87, [
      ...quarters("USD", [["2025-12-31", 6_003e6, 7_715e6, 13_718e6, 80_039e6], ["2026-03-31", 5_347e6, 6_771e6, 12_118e6, 85_138e6],
        ["2026-06-30", 18_195e6, 8_689e6, 26_884e6, 116_017e6], ["2026-09-30", 0, 6_803e6, 0, 113_164e6]]).slice(0, 3),
      withoutOperatingIncome(quarters("USD", [["2026-09-30", 0, 6_803e6, 0, 113_164e6]])[0]!, { pretaxIncome: 21_236e6, taxProvision: 5_214e6, totalDebt: 34.25e9, cashAndCashEquivalents: 12.153e9 }),
    ], { marketCap: 676.62e9, enterpriseValue: 698.7e9, revenue: 394.36e9 }),
    expected: 698.7e9 / (6_003e6 + 5_347e6 + 18_195e6 + 21_236e6 + 7_715e6 + 6_771e6 + 8_689e6 + 6_803e6),
  },
};

test("RV's EV/EBITDA is GE's: the listing's EV over trailing operating income plus D&A, never the provider's EBITDA", async () => {
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    async getTickerFinancials(symbol, exchange) { return PEERS[exchange ? `${symbol}:${exchange}` : symbol]!.financials; },
  }) } as HeadlessPaneContext;
  const symbols = Object.keys(PEERS);
  const report = await relativeValuationHeadless.load({ symbols, argument: symbols, rawArgument: symbols.join(","), options: { columns: "evEbitda" } }, ctx);
  for (const [symbol, { financials, expected }] of Object.entries(PEERS)) {
    const ge = extractFundamentalSeries(financials, {
      kind: "security", instrument: { symbol: financials.quote!.symbol }, fieldId: "valuation.evEbitda", period: "ttm", timestampMode: "available-at",
    } as Parameters<typeof extractFundamentalSeries>[1]).at(-1)!;
    const rv = report.rows.find((row) => row.symbol === symbol)!;
    expect(ge.periodLabel).toBe("Current");
    expect(rv.evEbitda).toBe(ge.value!);
    expect(rv.evEbitda as number).toBeCloseTo(expected, 9);
  }
  // Named for the market cap + total debt - cash where that stood in, and the rate the ADR's EUR statements took.
  expect(report.rows.find((row) => row.symbol === "ASML")).toMatchObject({
    evEbitdaSource: "Market cap + total debt - cash over trailing operating income plus D&A; statements in EUR at 1.133 USD" });
  expect(report.notes).toEqual([
    "ASML: EV/EBITDA statements in EUR at 1.133 USD.",
    "XOM: EV/EBITDA operating income derived as pretax income for the period to 2026-09-30.",
  ]);
});

test("where RV's EV/EBITDA is N/M, GE ends on N/M too: EBITDA at or below zero, a bank's or an insurer's", async () => {
  const loss = listing("RIVN", "USD", 13.61, quarters("USD", [
    ["2025-12-31", -1_100e6, 280e6, -800e6, 1_300e6], ["2026-03-31", -950e6, 290e6, -700e6, 1_250e6],
    ["2026-06-30", -900e6, 300e6, -600e6, 1_500e6], ["2026-09-30", -800e6, 310e6, -500e6, 1_800e6],
  ]), { marketCap: 18.54e9, enterpriseValue: 14.2e9, revenue: 5.85e9 });
  // An insurer reporting operating income and D&A still reads N/M: claims and float are its operations.
  const insurer = listing("AIG", "USD", 77.75, quarters("USD", [
    ["2025-12-31", 1_200e6, 100e6, 1_300e6, 6_800e6], ["2026-03-31", 1_100e6, 100e6, 1_200e6, 6_700e6],
    ["2026-06-30", 1_300e6, 100e6, 1_400e6, 6_900e6], ["2026-09-30", 1_250e6, 100e6, 1_350e6, 7_000e6],
  ]), { marketCap: 40.31e9, enterpriseValue: 49.1e9, revenue: 27.4e9 }, "Insurance - Diversified");
  const all: Record<string, TickerFinancials> = { RIVN: loss, AIG: insurer };
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    async getTickerFinancials(symbol) { return all[symbol]!; },
  }) } as HeadlessPaneContext;
  const report = await relativeValuationHeadless.load({ symbols: ["RIVN", "AIG"], argument: ["RIVN", "AIG"], rawArgument: "RIVN,AIG", options: { columns: "evEbitda" } }, ctx);
  const source = (financials: TickerFinancials) => ({
    kind: "security", instrument: { symbol: financials.quote!.symbol }, fieldId: "valuation.evEbitda", period: "ttm", timestampMode: "available-at",
  }) as Parameters<typeof extractFundamentalSeries>[1];
  for (const [symbol, financials, reason] of [
    ["RIVN", loss, "Trailing EBITDA is not positive"], ["AIG", insurer, "not meaningful for banks and insurers"],
  ] as const) {
    // RIVN's GE read -7.78 where RV read N/M.
    expect(extractFundamentalSeries(financials, source(financials)).filter((point) => point.value !== null)).toEqual([]);
    expect(valuationNotMeaningful(financials, source(financials))).toEqual({ reason, asOf: "2026-09-30" });
    expect(report.rows.find((row) => row.symbol === symbol)).toMatchObject({ evEbitda: null, evEbitdaNotMeaningful: reason });
  }
  expect(report.notes).toEqual(["RIVN: EV/EBITDA N/M, trailing EBITDA is not positive.", "AIG: EV/EBITDA N/M, not meaningful for banks and insurers."]);
});

test("a listing abroad gets the same columns: gross margin over the trailing twelve months, a withdrawn EV's computed one, targets in the asked currency", async () => {
  // Reports only fiscal years: the year's margin, named for it.
  const yearly = mapCloudFinancials({
    annualStatements: [{ date: "2025-12-31", currency: "EUR", totalRevenue: 200, grossProfit: 70, operatingIncome: 30, depreciationAndAmortization: 10 }],
    quarterlyStatements: [], priceHistory: [], financialCurrency: "EUR",
    quote: { symbol: "SEMI", price: 10, change: 0, changePercent: 0, currency: "EUR", lastUpdated: Date.parse("2026-11-06T21:00:00Z") },
  } as unknown as CloudFinancialsPayload);
  const all: Record<string, TickerFinancials> = { "ASML:AMS": PEERS["ASML:AMS"]!.financials, ASML: PEERS.ASML!.financials, "SEMI:XETRA": yearly };
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    async getTickerFinancials(symbol, exchange) { return all[exchange ? `${symbol}:${exchange}` : symbol]!; },
  }) } as HeadlessPaneContext;
  const symbols = Object.keys(all);
  const report = await relativeValuationHeadless.load({ symbols, argument: symbols, rawArgument: symbols.join(","), options: { columns: "grossMargin" } }, ctx);
  const row = (symbol: string) => report.rows.find((candidate) => candidate.symbol === symbol)!;
  expect(row("ASML:AMS")).toMatchObject({ grossMarginPercent: 50, grossMarginAsOf: "2026-09-30" });
  expect(row("SEMI:XETRA")).toMatchObject({ grossMarginPercent: 35, grossMarginPeriod: "FY25", grossMarginAsOf: "2025-12-31" });
  expect(report.notes ?? []).toEqual([]);
  // EV/S over the market cap + total debt - cash the withdrawn 37.25T was checked against, EUR revenue at the check's rate, and the note says so.
  expect(row("ASML")).toMatchObject({ evSales: 535.04e9 / (39.47e9 * 1.133), evSalesBasis: "computed",
    evSalesNote: "EV 535.04B USD computed from market cap + total debt - cash (balance sheet 2026-09-30, EUR at 1.133 USD); the provider's 37.25T USD failed validation against it." });
  // NT$3,409.80 at 32.797 TWD to the dollar.
  const targets = convertTargets([{ symbol: "2330:TWSE", targetMean: 3_409.8, targetCurrency: "TWD" }, { symbol: "NVDA", targetMean: 250, targetCurrency: "USD" }],
    "USD", new Map([["TWD", { rate: 1 / 32.797, asOf: "2026-11-06T21:59:00Z" }]]));
  expect(targets.rows[0]).toMatchObject({ targetCurrency: "USD", targetMeanNative: 3_409.8, targetNativeCurrency: "TWD" });
  expect(targets.rows[0]!.targetMean as number).toBeCloseTo(103.97, 2);
  expect(targets.rows[1]).toEqual({ symbol: "NVDA", targetMean: 250, targetCurrency: "USD" });
  // With no TWD rate the target stays in TWD, as served, never relabelled USD, and the currency is named for the warning.
  const unrated = convertTargets([{ symbol: "2330:TWSE", targetMean: 3_409.8, targetCurrency: "TWD" }], "USD", new Map());
  expect(unrated.rows).toEqual([{ symbol: "2330:TWSE", targetMean: 3_409.8, targetCurrency: "TWD" }]);
  expect(unrated.unconverted).toEqual([{ currency: "TWD", symbols: ["2330:TWSE"] }]);
});
