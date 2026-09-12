import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { createDefaultConfig } from "../types/config";
import type { TickerFinancials } from "../types/financials";
import { loadChartPaneModel } from "../plugins/builtin/chart-composer/headless";
import { extractFundamentalSeries, valuationCurrencyWarning } from "./fundamentals";
import { CHART_SPEC_VERSION, type ChartSpec, type SecuritySeriesSource } from "./types";

const fields = ["trailingPE", "priceSales", "evSales", "evEbitda", "priceFcf"] as const;
const source = (metric: string): SecuritySeriesSource => ({
  kind: "security", instrument: { symbol: "SHEL", exchange: "LSE" },
  fieldId: `valuation.${metric}`, period: "annual", timestampMode: "available-at",
});
const fixture = (): TickerFinancials => ({
  financialCurrency: "GBP",
  quote: { symbol: "SHEL", currency: "GBP", price: 35, change: 0, changePercent: 0,
    lastUpdated: Date.parse("2026-09-11T16:00:00Z") },
  annualStatements: [{ date: "2025-12-31", availableAt: "2026-03-12", eps: 3,
    totalRevenue: 300, dilutedShares: 10, totalDebt: 20, cashAndCashEquivalents: 5,
    ebitda: 60, freeCashFlow: 25 }],
  quarterlyStatements: [],
  priceHistory: [{ date: new Date("2026-03-12"), close: 30 }],
});

test("missing statement currency cannot turn a known foreign or unknown basis into valuation ratios", () => {
  for (const reporting of ["USD", undefined]) {
    const data = fixture(); data.financialCurrency = reporting;
    // Summary fundamentals may have been converted separately and cannot fill this gap.
    data.fundamentals = { financialCurrency: "GBP" };
    const original = JSON.stringify(data);
    for (const metric of fields) {
      expect(extractFundamentalSeries(data, source(metric))).toEqual([]);
      expect(valuationCurrencyWarning(data, source(metric))).toContain(reporting ?? "unknown");
    }
    expect(extractFundamentalSeries(data, { ...source(""), fieldId: "fundamental.totalRevenue" })[0]?.value).toBe(300);
    expect(JSON.stringify(data)).toBe(original);
  }
});

test("same-currency monetary ratios retain historical and current values", () => {
  const data = fixture();
  const expected = [[10, 35 / 3], [1, 350 / 300], [315 / 300, 365 / 300], [315 / 60, 365 / 60], [12, 14]];
  for (const [index, metric] of fields.entries()) {
    expect(extractFundamentalSeries(data, source(metric)).map((point) => point.value)).toEqual(expected[index]!);
    expect(valuationCurrencyWarning(data, source(metric))).toBeUndefined();
  }
  // Row metadata wins over a contradictory current aggregate.
  data.annualStatements[0]!.currency = "GBP";
  data.financialCurrency = "EUR";
  expect(extractFundamentalSeries(data, source("trailingPE")).at(-1)?.value).toBe(35 / 3);
});

test("missing or unknown price units cannot borrow the statement currency or an exchange default", () => {
  for (const currency of [undefined, "", "   ", "XXX", "unknown"]) {
    const data = fixture(); data.quote!.currency = currency;
    for (const metric of fields) {
      expect(extractFundamentalSeries(data, source(metric))).toEqual([]);
      expect(valuationCurrencyWarning(data, source(metric))).toContain("unknown price");
    }
    // The provider's own forward multiple does not multiply these statement legs.
    data.fundamentals = { forwardPE: 12 };
    expect(extractFundamentalSeries(data, source("forwardPE"))[0]?.value).toBe(12);
    expect(valuationCurrencyWarning(data, source("forwardPE"))).toBeUndefined();
  }
});

test("historical currency changes prevent filling missing row units from the current aggregate", () => {
  const data = fixture();
  data.quote!.lastUpdated = 0; // Historical observations only.
  data.annualStatements = [
    { ...data.annualStatements[0]!, date: "2023-12-31", currency: "GBP" },
    { ...data.annualStatements[0]!, date: "2024-12-31", currency: "EUR" },
    { ...data.annualStatements[0]!, date: "2025-12-31" },
  ];
  const points = extractFundamentalSeries(data, source("trailingPE"));
  expect(points.map((point) => point.observedAt.toISOString().slice(0, 10))).toEqual(["2023-12-31"]);
  expect(valuationCurrencyWarning(data, source("trailingPE"))).toContain("EUR/unknown");
});

test("GBP and explicitly declared pence denominations produce the same ratios without FX or double scaling", () => {
  const baseline = fixture();
  for (const currency of ["GBp", "GBX"]) {
    const raw = fixture(); raw.quote!.currency = currency; raw.quote!.price *= 100;
    raw.priceHistory = raw.priceHistory.map((row) => ({ ...row, close: row.close * 100 }));
    for (const metric of fields) {
      expect(extractFundamentalSeries(raw, source(metric)).map((point) => point.value))
        .toEqual(extractFundamentalSeries(baseline, source(metric)).map((point) => point.value));
      expect(valuationCurrencyWarning(raw, source(metric))).toBeUndefined();
    }
  }
  const minorStatement = fixture();
  minorStatement.annualStatements[0]!.currency = "GBp";
  for (const key of ["eps", "totalRevenue", "totalDebt", "cashAndCashEquivalents", "ebitda", "freeCashFlow"] as const) {
    minorStatement.annualStatements[0]![key]! *= 100;
  }
  for (const metric of fields) {
    expect(extractFundamentalSeries(minorStatement, source(metric)).map((point) => point.value))
      .toEqual(extractFundamentalSeries(baseline, source(metric)).map((point) => point.value));
  }
  // A denomination change cannot supply the units of a missing historical row.
  minorStatement.annualStatements.push({ ...baseline.annualStatements[0]!, date: "2026-03-31" });
  expect(valuationCurrencyWarning(minorStatement, source("trailingPE"))).toContain("unknown");
});

test("chart and headless export explain withheld currency ratios and recover when compatible units arrive", async () => {
  const data = fixture(); data.financialCurrency = "USD";
  const spec: ChartSpec = { version: CHART_SPEC_VERSION, viewport: { range: "5Y", resolution: "1d" },
    panels: [{ id: "main" }], studies: [], series: [{ id: "pe", source: source("trailingPE"),
      style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }] };
  const context = {
    marketData: createTestDataProvider({ getTickerFinancials: async () => data,
      getQuote: async () => data.quote!, getPriceHistoryForResolution: async () => data.priceHistory }),
    config: createDefaultConfig("/tmp/valuation-currency-test"), signal: new AbortController().signal,
    apiClient: {} as Parameters<typeof loadChartPaneModel>[1]["apiClient"],
  };
  const blocked = await loadChartPaneModel(spec, context);
  expect(blocked.series[0]?.points).toEqual([]);
  expect(blocked.unavailableSymbols).toHaveLength(1);
  expect(blocked.metadata?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("USD reporting, GBP price")]));
  expect(blocked.metadata?.summaries).toEqual(expect.arrayContaining([expect.objectContaining({ endValue: null, unit: "x" })]));
  data.annualStatements[0]!.currency = "GBP";
  const recovered = await loadChartPaneModel(spec, context);
  expect(recovered.series[0]?.points.at(-1)?.value).toBe(35 / 3);
  expect(recovered.unavailableSymbols).toEqual([]);
  expect((recovered.metadata?.warnings as string[]).some((warning) => warning.includes("Valuation currency"))).toBe(false);
});
