import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { sessionQuotes } from "../test-support/test-fixture-session-quotes";
import { createDefaultConfig } from "../types/config";
import type { FinancialStatement, TickerFinancials } from "../types/financials";
import { loadChartPaneModel } from "../plugins/builtin/chart-composer/headless";
import { deriveQuarterlyStatements, extractFundamentalSeries } from "./fundamentals";
import type { ChartSpec, SecuritySeriesSource } from "./types";

const source = (period: SecuritySeriesSource["period"] = "annual", metric = "trailingPE"): SecuritySeriesSource => ({
  kind: "security", instrument: { symbol: "TEST", exchange: "NYSE" },
  fieldId: `valuation.${metric}`, period, timestampMode: "available-at",
});
const fixture = (): TickerFinancials => ({
  financialCurrency: "USD",
  quote: { symbol: "TEST", currency: "USD", price: 60, lastUpdated: Date.parse("2026-09-11T20:00Z"), change: 0, changePercent: 0 },
  annualStatements: [
    { date: "2024-12-31", availableAt: "2025-03-01", currency: "USD", eps: 10 },
    { date: "2025-12-31", availableAt: "2026-03-01", currency: "USD", eps: -2 },
  ],
  quarterlyStatements: [],
  priceHistory: [
    { date: new Date("2025-03-01"), close: 50 },
    { date: new Date("2026-03-01"), close: 55 },
  ],
});

test("Current valuation chooses the latest available statement before evaluating its denominator", () => {
  for (const earnings of [-2, 0, undefined]) {
    const data = fixture(); data.annualStatements[1]!.eps = earnings;
    const original = JSON.stringify(data);
    expect(extractFundamentalSeries(data, source()).map(({ value, periodLabel }) => [value, periodLabel]))
      .toEqual([[5, "Year ended 2024-12-31"], [null, "Year ended 2025-12-31"]]);
    expect(JSON.stringify(data)).toBe(original);
  }
  // An unpublished loss does not replace the earnings known at this quote time.
  const future = fixture(); future.annualStatements[1]!.fieldAvailability = { eps: "2026-10-01" };
  expect(extractFundamentalSeries(future, source()).find(point => point.periodLabel === "Current")?.value).toBe(6);
  // A corrected positive latest observation resumes calculation on that period.
  future.annualStatements[1] = { ...future.annualStatements[1]!, eps: 3, fieldAvailability: { eps: "2026-03-01" } };
  expect(extractFundamentalSeries(future, source()).at(-1)?.value).toBe(20);
});

test("automatic valuation coverage does not substitute a profitable annual period for loss-making TTM inputs", () => {
  const data = fixture();
  data.annualStatements = [data.annualStatements[0]!];
  data.quarterlyStatements = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"]
    .map((date) => ({ date, currency: "USD", eps: -1 }));
  for (const period of ["auto", "ttm"] as const) {
    expect(extractFundamentalSeries(data, source(period))).toEqual([]);
  }
  // Missing TTM earnings coverage can still use the independently requested
  // automatic annual fallback; this is different from known unprofitable input.
  data.quarterlyStatements = data.quarterlyStatements.map(({ eps, ...row }) => row);
  expect(extractFundamentalSeries(data, source("auto")).at(-1)?.value).toBe(6);
  expect(extractFundamentalSeries(data, source("ttm"))).toEqual([]);
});

test("finite reported EPS takes precedence over aggregate income and shares, including zero", () => {
  for (const eps of [0, -0, -2, 2]) {
    const data = fixture();
    Object.assign(data.annualStatements[1]!, { eps, netIncome: 100, netIncomeCommonStockholders: eps * 10, dilutedShares: 10 });
    const original = structuredClone(data);
    const points = extractFundamentalSeries(data, source());
    expect(points.map(({ value }) => value)).toEqual(eps > 0 ? [5, 27.5, 30] : [5, null]);
    expect(data).toEqual(original);
  }
  // Only unavailable/nonfinite reported EPS keeps the existing derivation.
  for (const eps of [undefined, NaN, Infinity]) {
    const data = fixture();
    Object.assign(data.annualStatements[1]!, { eps, netIncome: 100, dilutedShares: 10 });
    expect(extractFundamentalSeries(data, source()).map(({ value }) => value)).toEqual([5, 5.5, 6]);
  }
});

test("zero TTM reported EPS is coverage, not permission to use aggregate income or annual EPS", () => {
  for (const earnings of [[0, 0, 0, 0], [1, -1, 2, -2]]) {
    const data = fixture();
    data.annualStatements = [data.annualStatements[0]!];
    data.quarterlyStatements = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"]
      .map((date, index) => ({ date, currency: "USD", eps: earnings[index], netIncome: 25, dilutedShares: 10 }));
    for (const period of ["auto", "ttm"] as const) {
      expect(extractFundamentalSeries(data, source(period))).toEqual([]);
    }
    data.quarterlyStatements = data.quarterlyStatements.map(({ eps, ...row }) => row);
    for (const period of ["auto", "ttm"] as const) {
      expect(extractFundamentalSeries(data, source(period)).at(-1)?.value).toBe(6);
    }
  }
});

test("reported zero EPS uses its own availability; absent EPS uses income and shares availability", () => {
  const data = fixture();
  const latest = data.annualStatements[1]!;
  Object.assign(latest, { eps: 0, netIncome: 200, dilutedShares: 10,
    fieldAvailability: { eps: "2026-03-01", netIncome: "2026-10-01", dilutedShares: "2026-10-01" } });
  // The known zero is effective even though alternative inputs are unpublished.
  expect(extractFundamentalSeries(data, source()).map(({ value }) => value)).toEqual([5, null]);
  latest.fieldAvailability = { eps: "2026-10-01", netIncome: "2026-03-01", dilutedShares: "2026-03-01" };
  // Before reported EPS is available, the older published period remains current.
  expect(extractFundamentalSeries(data, source()).map(({ value }) => value)).toEqual([5, 6, null]);
  latest.eps = undefined;
  expect(extractFundamentalSeries(data, source()).map(({ value }) => value)).toEqual([5, 2.75, 3]);
  latest.fieldAvailability.dilutedShares = "2026-10-01";
  expect(extractFundamentalSeries(data, source()).find(({ periodLabel }) => periodLabel === "Current")?.value).toBe(6);
});

test("missing EPS selects common income including zero and loss, without requiring aggregate income", () => {
  for (const common of [60, 0, -20]) {
    for (const netIncome of [100, undefined]) {
      const data = fixture();
      Object.assign(data.annualStatements[1]!, { eps: undefined, netIncome, netIncomeCommonStockholders: common, dilutedShares: 10, basicShares: 8 });
      const original = structuredClone(data);
      const points = extractFundamentalSeries(data, source());
      expect(points.map(({ value }) => value)).toEqual(common > 0 ? [5, 55 / 6, 10] : [5, null]);
      expect(points.every(({ provenance }) => provenance?.quality === "derived")).toBe(true);
      expect(data).toEqual(original);
    }
  }
  // Unusable common-income inputs do not manufacture a number or zero claim.
  for (const common of [undefined, NaN, Infinity]) {
    const data = fixture();
    Object.assign(data.annualStatements[1]!, { eps: undefined, netIncome: 100, netIncomeCommonStockholders: common, dilutedShares: 10 });
    expect(extractFundamentalSeries(data, source()).at(-1)?.value).toBe(6);
  }
});

test("common-income fallback uses selected share and income availability, not aggregate publication time", () => {
  const data = fixture();
  const latest = data.annualStatements[1]!;
  Object.assign(latest, { eps: undefined, netIncome: 100, netIncomeCommonStockholders: 60, dilutedShares: 10, basicShares: 8,
    fieldAvailability: { netIncome: "2026-10-01", netIncomeCommonStockholders: "2026-03-01", dilutedShares: "2026-03-01", basicShares: "2026-03-01" } });
  let points = extractFundamentalSeries(data, source());
  expect(points.at(-1)?.value).toBe(10);
  expect(points[1]?.availableAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  latest.fieldAvailability!.netIncomeCommonStockholders = "2026-10-01";
  expect(extractFundamentalSeries(data, source()).find(({ periodLabel }) => periodLabel === "Current")?.value).toBe(6);
  latest.fieldAvailability!.netIncomeCommonStockholders = "2026-03-01";
  latest.fieldAvailability!.dilutedShares = "2026-10-01";
  expect(extractFundamentalSeries(data, source()).find(({ periodLabel }) => periodLabel === "Current")?.value).toBe(6);
  for (const dilutedShares of [undefined, 0, -1, NaN, Infinity]) {
    latest.dilutedShares = dilutedShares;
    expect(extractFundamentalSeries(data, source()).at(-1)?.value).toBe(8);
  }
  latest.basicShares = undefined;
  expect(extractFundamentalSeries(data, source()).map(({ value }) => value)).toEqual([5, null]);
  latest.ordinarySharesNumber = 5;
  latest.fieldAvailability!.ordinarySharesNumber = "2026-03-01";
  expect(extractFundamentalSeries(data, source()).at(-1)?.value).toBe(5);
  latest.ordinarySharesNumber = undefined;
  latest.shareIssued = 4;
  latest.fieldAvailability!.shareIssued = "2026-03-01";
  expect(extractFundamentalSeries(data, source()).at(-1)?.value).toBe(4);
  latest.dilutedShares = 10;
  latest.fieldAvailability!.dilutedShares = "2026-03-01";
  delete latest.fieldAvailability!.netIncomeCommonStockholders;
  const undated = extractFundamentalSeries(data, source()).find(({ periodLabel }) => periodLabel === "Year ended 2025-12-31")!;
  expect(undated.availableAt).toBeUndefined();
  expect(undated.date.toISOString()).toBe("2025-12-31T00:00:00.000Z");
});

test("TTM keeps a complete common numerator and averaged shares; partial common coverage cannot become aggregate earnings", () => {
  const data = fixture();
  data.annualStatements = [data.annualStatements[0]!];
  data.quarterlyStatements = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"].map((date, index) => ({
    date, currency: "USD", netIncome: 25, netIncomeCommonStockholders: [6, 12, 18, 24][index],
    dilutedShares: [8, 10, 12, 10][index], basicShares: 5,
    fieldAvailability: { netIncomeCommonStockholders: "2026-04-30", dilutedShares: "2026-05-01", netIncome: "2026-10-01" },
  }));
  for (const period of ["ttm", "auto"] as const) {
    const points = extractFundamentalSeries(data, source(period));
    expect(points.at(-1)?.value).toBe(10);
    expect(points[0]?.availableAt?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  }
  data.quarterlyStatements[1]!.netIncomeCommonStockholders = undefined;
  for (const period of ["ttm", "auto"] as const) expect(extractFundamentalSeries(data, source(period))).toEqual([]);
  expect(extractFundamentalSeries(data, { ...source("ttm"), fieldId: "fundamental.netIncome" }).at(-1)?.value).toBe(100);
  // Complete reported EPS overrides the fallback coverage guard, including zero.
  for (const eps of [0, 0.5]) {
    for (const quarter of data.quarterlyStatements) { quarter.eps = eps; quarter.fieldAvailability!.eps = "2026-04-30"; }
    expect(extractFundamentalSeries(data, source("auto")).at(-1)?.value).toBe(eps === 0 ? undefined : 30);
  }
  for (const quarter of data.quarterlyStatements) {
    delete quarter.eps; delete quarter.netIncomeCommonStockholders;
    quarter.fieldAvailability!.netIncome = "2026-04-30";
  }
  expect(extractFundamentalSeries(data, source("auto")).at(-1)?.value).toBe(6);
});

test("reported Q4 common earnings use their own income and share dates while unresolved EPS blocks fallback", () => {
  const annual: FinancialStatement = { date: "2025-12-31", currency: "USD", netIncome: 100, netIncomeCommonStockholders: 60, dilutedShares: 10,
    fieldAvailability: { netIncome: "2026-03-01", netIncomeCommonStockholders: "2026-03-05", dilutedShares: "2026-03-06" } };
  const quarters: FinancialStatement[] = ["2025-03-31", "2025-06-30", "2025-09-30"].map((date, index) => ({ date, currency: "USD", netIncome: 25,
    netIncomeCommonStockholders: [10, 20, 15][index], dilutedShares: [8, 10, 12][index], availableAt: "2025-11-01" }));
  // Common allocations and weighted-average shares both require quarter inputs.
  quarters.push({ date: "2025-12-31", currency: "USD", netIncomeCommonStockholders: 15, dilutedShares: 10,
    fieldAvailability: { netIncomeCommonStockholders: "2026-03-05", dilutedShares: "2026-03-06" } });
  const q4 = deriveQuarterlyStatements(quarters, [annual]).at(-1)!;
  expect(q4).toMatchObject({ netIncomeCommonStockholders: 15, dilutedShares: 10,
    fieldAvailability: { netIncomeCommonStockholders: "2026-03-05", dilutedShares: "2026-03-06" } });
  const data = { ...fixture(), annualStatements: [annual], quarterlyStatements: quarters };
  const points = extractFundamentalSeries(data, source("ttm"));
  expect(points.at(-1)?.value).toBe(10);
  expect(points[0]?.availableAt?.toISOString()).toBe("2026-03-06T00:00:00.000Z");
  annual.epsBasis = { status: "unresolved", source: "sec", originalValue: 6, basisDate: "2026-03-01", evidence: [] };
  quarters[3]!.epsBasis = { ...annual.epsBasis, originalValue: 1.5 };
  expect(extractFundamentalSeries(data, source("annual"))).toEqual([]);
  expect(extractFundamentalSeries(data, source("ttm"))).toEqual([]);
});

test("other current monetary ratios cannot skip a latest zero denominator", () => {
  const cases: Array<[string, Partial<FinancialStatement>, keyof FinancialStatement]> = [
    ["priceSales", { totalRevenue: 100, dilutedShares: 10 }, "totalRevenue"],
    ["evSales", { totalRevenue: 100, dilutedShares: 10, totalDebt: 20, cashAndCashEquivalents: 5 }, "totalRevenue"],
    ["evEbitda", { ebitda: 100, dilutedShares: 10, totalDebt: 20, cashAndCashEquivalents: 5 }, "ebitda"],
    ["priceFcf", { freeCashFlow: 100, dilutedShares: 10 }, "freeCashFlow"],
  ];
  for (const [metric, fields, denominator] of cases) {
    const data = fixture();
    data.annualStatements = data.annualStatements.map((row, index) => ({ ...row, ...fields, ...(index ? { [denominator]: 0 } : {}) }));
    expect(extractFundamentalSeries(data, source("annual", metric)).some((point) => point.periodLabel === "Current")).toBe(false);
    data.quarterlyStatements = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"]
      .map((date) => ({ date, currency: "USD", ...fields, [denominator]: 0 }));
    expect(extractFundamentalSeries(data, source("auto", metric))).toEqual([]);
  }
});

test("chart and headless export preserve historical P/E without a Current point sourced from older earnings", async () => {
  const data = fixture();
  const spec: ChartSpec = { version: 1, viewport: { range: "5Y", resolution: "1d" }, panels: [{ id: "main" }], studies: [],
    series: [{ id: "pe", source: source(), style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }] };
  const context = { marketData: createTestDataProvider({ getTickerFinancials: async () => data,
    getQuote: async () => data.quote!, getPriceHistoryForResolution: async () => data.priceHistory }),
    apiClient: {} as any, config: createDefaultConfig("/tmp/valuation-denominator-test"), signal: new AbortController().signal };
  const model = await loadChartPaneModel(spec, context);
  expect(model.series[0]?.points.map((point) => point.value)).toEqual([5, null]);
  expect(model.snapshot.financials[0]?.[1].annualStatements.at(-1)?.eps).toBe(-2);
  data.annualStatements[1]!.eps = 3;
  const recovered = await loadChartPaneModel(spec, context);
  expect(recovered.series[0]?.points.at(-1)?.value).toBe(20);
});

test("an annual chart's Current multiple is the regular close over the latest trailing twelve months, and its P/E the served one", () => {
  // After hours: printed 210 after a 200 close, two quarters after the fiscal year (EPS 5, TTM 6).
  const quote = { ...sessionQuotes("TEST", { listingExchangeName: "NYSE", instrumentType: "Common Stock" }).weekend, price: 210, regularClose: 200 };
  const quarter = (date: string, eps: number): FinancialStatement => ({ date, availableAt: date, currency: "USD", eps, totalRevenue: 100, dilutedShares: 10 });
  const data: TickerFinancials = { ...fixture(), quote,
    annualStatements: [{ date: "2025-12-31", availableAt: "2026-02-20", currency: "USD", eps: 5, totalRevenue: 300, dilutedShares: 10 }],
    quarterlyStatements: [quarter("2025-09-30", 1.2), quarter("2025-12-31", 1.3), quarter("2026-03-31", 1.5), quarter("2026-06-30", 2)],
    priceHistory: [{ date: new Date("2026-02-20"), close: 150 }] };
  const current = (metric: string, financials = data) => extractFundamentalSeries(financials, source("annual", metric)).at(-1)!;
  expect(current("trailingPE")).toMatchObject({ periodLabel: "Current", value: 200 / 6, date: new Date("2026-10-09T20:00:00Z") });
  expect(current("priceSales").value).toBe(200 * 10 / 400);
  // The served P/E `valuation` prints, moved from the print it was measured at to the close.
  const served = { ...data, fundamentals: { trailingPE: 210 / 6.25, eps: 6.25, financialCurrency: "USD", marketCapCurrency: "USD" } };
  expect(current("trailingPE", served).value).toBeCloseTo(32, 10);
  expect(extractFundamentalSeries(served, source("annual")).map(({ value }) => value).slice(0, -1)).toEqual([30]);
});
