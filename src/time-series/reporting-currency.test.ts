import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import type { TickerFinancials } from "../types/financials";
import { extractFundamentalSeries } from "./fundamentals";
import { resolveChartSpecData } from "./resolve";
import { graphRowsForFinancials, summarizeResolvedSeries } from "./reporting";
import { CHART_SPEC_VERSION, type ChartSpec, type SecuritySeriesSource } from "./types";

const source = (fieldId = "fundamental.totalRevenue"): SecuritySeriesSource => ({
  kind: "security", instrument: { symbol: "SHEL", exchange: "LSE" }, fieldId,
  period: "annual", timestampMode: "period-end",
});
const financials = (): TickerFinancials => ({
  financialCurrency: "USD",
  quote: { symbol: "SHEL", currency: "GBP", price: 35.37, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-01-02") },
  priceHistory: [{ date: new Date("2025-12-31"), close: 35 }],
  quarterlyStatements: [],
  annualStatements: [2024, 2025].map((year, i) => ({
    date: `${year}-12-31`, currency: "USD", totalRevenue: 100 + i * 20, operatingIncome: 10 + i * 2, eps: 2 + i,
  })),
});
async function resolve(value: TickerFinancials, fieldId = "fundamental.totalRevenue") {
  const spec: ChartSpec = {
    version: CHART_SPEC_VERSION, viewport: { range: "5Y", resolution: "1d" },
    panels: [{ id: "main" }], studies: [],
    series: [{ id: "series", source: source(fieldId), style: "columns", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }],
  };
  return resolveChartSpecData(spec, {
    now: new Date("2026-01-02"),
    dataProvider: createTestDataProvider({
      getTickerFinancials: async () => value,
      getQuote: async () => { if (!value.quote) throw new Error("Quote unavailable"); return value.quote; },
      getPriceHistoryForResolution: async () => value.priceHistory,
    }),
  });
}

test("statement money and EPS use reporting currency while the London price stays GBP", async () => {
  const value = financials();
  const revenue = (await resolve(value)).series[0]!;
  expect(revenue.unit).toBe("USD");
  expect(revenue.points.map((point) => point.value)).toEqual([100, 120]);
  expect(summarizeResolvedSeries(revenue)).toMatchObject({ unit: "USD", startValue: 100, endValue: 120 });
  expect((await resolve(value, "fundamental.eps")).series[0]?.unit).toBe("USD/share");
  expect((await resolve(value, "market.close")).series[0]?.unit).toBe("GBP/share");
  expect(value.annualStatements[1]?.totalRevenue).toBe(120);
});

test("statement currency survives missing quotes and outranks inconsistent aggregate metadata", async () => {
  const value = financials();
  value.quote = undefined;
  value.financialCurrency = "EUR";
  const result = await resolve(value);
  expect(result.series[0]).toMatchObject({ unit: "USD", unitGroup: "currency-total:USD" });
  expect(result.errors).toEqual([]);
  expect(result.series[0]?.points.at(-1)?.value).toBe(120);
  value.financialCurrency = "USD";
  value.annualStatements.forEach((row) => { delete row.currency; });
  expect((await resolve(value)).series[0]?.unit).toBe("USD");
});

test("an unavailable reporting currency is not replaced by the share quotation currency", async () => {
  const value = financials();
  value.financialCurrency = undefined;
  value.annualStatements.forEach((row) => { delete row.currency; });
  const result = await resolve(value);
  expect(result.series[0]?.unit).toBe("currency");
  expect(result.warnings.some((warning) => warning.includes("Reporting currency is unavailable"))).toBe(true);
});

test("currency changes preserve source dates as gaps and do not suppress dimensionless margins", async () => {
  const value = financials();
  value.annualStatements[0]!.currency = "EUR";
  const points = extractFundamentalSeries(value, source());
  expect(points.map((point) => point.value)).toEqual([null, 120]);
  expect(points[0]).toMatchObject({ observedAt: new Date("2024-12-31"), provenance: { currency: "EUR" } });
  expect(value.annualStatements[0]!.totalRevenue).toBe(100);
  const result = await resolve(value);
  expect(result.series[0]?.unit).toBe("USD");
  expect(result.warnings.some((warning) => warning.includes("Only USD reporting-currency"))).toBe(true);
  expect(extractFundamentalSeries(value, source("fundamental.operatingMargin")).map((point) => point.value)).toEqual([10, 10]);

  // Aggregate USD does not establish the currency of a missing historical row
  // once the supplied statements show that the reporting currency changed.
  value.annualStatements.splice(1, 0, { date: "2025-06-30", totalRevenue: 115 });
  expect(extractFundamentalSeries(value, source()).map((point) => point.value)).toEqual([null, null, 120]);

  // The headless table filters unavailable values, but a missing intervening
  // reporting-currency period must not become ordinary annual growth.
  value.annualStatements = [
    { date: "2023-12-31", currency: "USD", totalRevenue: 100 },
    { date: "2024-12-31", currency: "EUR", totalRevenue: 110 },
    { date: "2025-12-31", currency: "USD", totalRevenue: 120 },
    { date: "2026-12-31", currency: "USD", totalRevenue: 132 },
  ];
  const rows = graphRowsForFinancials(value, "fundamental", "totalRevenue", "annual", "SHEL");
  expect(rows.map((row) => row.value)).toEqual([100, 120, 132]);
  expect(rows.map((row) => row.growth)).toEqual([null, null, .1]);
});
