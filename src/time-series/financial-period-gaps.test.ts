import { expect, test } from "bun:test";
import { buildCompositeChartScene } from "../components/chart/composite/scene";
import { chartHeadless } from "../plugins/builtin/chart-composer/headless";
import { buildFundamentalChartPreset, buildValuationChartPreset } from "../plugins/builtin/chart-composer/presets";
import { createTestDataProvider } from "../test-support/data-provider";
import { createDefaultConfig } from "../types/config";
import type { FinancialStatement, TickerFinancials } from "../types/financials";
import { alignTimeSeries } from "./alignment";
import { extractFundamentalSeries } from "./fundamentals";
import type { SecuritySeriesSource } from "./types";

const row = (date: string, fields: Partial<FinancialStatement>): FinancialStatement => ({
  date, currency: "USD", availableAt: new Date(Date.parse(date) + 45 * 86_400_000).toISOString().slice(0, 10), ...fields,
});
const data = (annualStatements: FinancialStatement[], quarterlyStatements: FinancialStatement[] = []): TickerFinancials => ({
  annualStatements, quarterlyStatements, financialCurrency: "USD",
  priceHistory: [...annualStatements, ...quarterlyStatements].map(statement => ({ date: new Date(statement.availableAt!), close: 30 })),
  quote: { symbol: "CYCLE", currency: "USD", price: 30, change: 0, changePercent: 0,
    lastUpdated: Date.parse("2026-09-11"), listingExchangeName: "NASDAQ", instrumentType: "EQUITY" },
});
const definition = (fieldId: string, period: SecuritySeriesSource["period"] = "annual"): SecuritySeriesSource => ({
  kind: "security", instrument: { symbol: "CYCLE", exchange: "NASDAQ" }, fieldId, period, timestampMode: "available-at",
});

async function load(financials: TickerFinancials, valuation = false) {
  const spec = valuation ? buildValuationChartPreset(["CYCLE:NASDAQ"]) : buildFundamentalChartPreset(["CYCLE:NASDAQ"]);
  spec.viewport = { range: "ALL", resolution: "auto", maxPoints: 3,
    dateWindow: { start: "2018-01-01", end: "2026-09-12" } };
  spec.series[0]!.source = definition(valuation ? "valuation.trailingPE" : "fundamental.totalRevenue");
  spec.series[0]!.style = "line";
  const provider = createTestDataProvider({ getTickerFinancials: async () => financials,
    getPriceHistoryForResolution: async () => financials.priceHistory, getDetailedPriceHistory: async () => financials.priceHistory });
  return chartHeadless("chart-composer-pane").load({ argument: "CYCLE:NASDAQ", rawArgument: "CYCLE:NASDAQ", symbols: ["CYCLE:NASDAQ"], options: {} }, {
    marketData: provider, apiClient: {} as any, config: createDefaultConfig("/tmp/gloom-period-gaps-test"),
    signal: new AbortController().signal, settings: { chartSpec: spec },
  });
}

test("financial chart and report retain missing periods, real zero and trailing gaps without connecting through them", async () => {
  const financials = data([
    row("2019-12-31", { totalRevenue: 100 }), row("2020-12-31", { operatingIncome: 5 }),
    row("2021-12-31", { totalRevenue: 0 }), row("2022-12-31", { totalRevenue: 120 }),
    row("2023-12-31", { operatingIncome: 8 }),
  ]);
  const original = structuredClone(financials);
  const result = await load(financials);
  // The latest three periods, the trailing gap among them: two have a value.
  expect(result.chart.series[0]!.points.map(p => p.value)).toEqual([0, 120, null]);
  expect(result.series[0]!.points.map(p => p.value)).toEqual([0, 120, null]);
  expect(result.metadata?.periodCoverage).toEqual([expect.objectContaining({ requested: 3, returned: 2, complete: false })]);
  const scene = buildCompositeChartScene(result.chart.series, [{ id: "main" }], { width: 80, height: 24 })!;
  expect(scene.panels[0]!.series[0]!.points.map(p => [p.value, p.breakBefore])).toEqual([[0, true], [120, false]]);
  expect(scene.cursorValues[0]!.value).toBeNull();
  expect(financials).toEqual(original);
});

test("a valuation cycle leaves gaps at losses, zero EPS and unknown denominators while retaining profitable periods", async () => {
  const result = await load(data([
    row("2019-12-31", { eps: 2 }), row("2020-12-31", { eps: -1 }),
    row("2021-12-31", { eps: 0 }), row("2022-12-31", { totalRevenue: 80 }),
    row("2023-12-31", { eps: 3 }), row("2024-12-31", { totalRevenue: 100 }),
  ]), true);
  expect(result.series[0]!.points.map(p => p.value)).toEqual([null, 10, null]);
  expect(result.series[0]!.points.some(p => p.periodLabel === "Current")).toBe(false);
  const scene = buildCompositeChartScene(result.chart.series, [{ id: "main" }], { width: 80, height: 24 })!;
  expect(scene.panels[0]!.series[0]!.points.map(p => p.breakBefore)).toEqual([true]);
  expect(result.metadata?.periodCoverage).toEqual([expect.objectContaining({ requested: 3, returned: 1, complete: false })]);
});

test("TTM periods retain broken windows between complete observations, including currency changes", () => {
  for (const kind of ["missing-quarter", "currency-change"] as const) {
    const dates = ["2022-03-31", "2022-06-30", "2022-09-30", "2022-12-31", "2023-03-31", "2023-06-30", "2023-09-30", "2023-12-31", "2024-03-31"];
    const quarters = dates.flatMap((date, index) => kind === "missing-quarter" && index === 4 ? []
      : [row(date, { totalRevenue: 10, ...(kind === "currency-change" && index === 4 ? { currency: "EUR" } : {}) })]);
    const points = extractFundamentalSeries(data([], quarters), definition("fundamental.totalRevenue", "ttm"));
    expect(points[0]!.value).toBe(40);
    expect(points.slice(1, -1).every(p => p.value === null)).toBe(true);
    // A missing quarter requires four new complete quarters; the currency
    // change similarly prevents mixing the incompatible observation.
    expect(points.at(-1)!.value).toBe(40);
    expect(points.find(p => p.observedAt.toISOString().startsWith("2023-06-30"))?.value).toBeNull();
  }
});

test("missing-field gaps become effective with their statement and wholly unavailable metrics remain empty", () => {
  // The provider can know the reporting/publication dates without any usable
  // numeric field in that row. Its timestamp must survive period merging.
  const financials = data([row("2022-12-31", { totalRevenue: 100 }), row("2023-12-31", {})]);
  const points = extractFundamentalSeries(financials, definition("fundamental.totalRevenue"));
  const gap = points[1]!;
  expect(gap.availableAt?.toISOString().slice(0, 10)).toBe(financials.annualStatements[1]!.availableAt);
  const result = alignTimeSeries([{ id: "revenue", points, interpolation: "step-after" } as any], {
    timeline: [new Date("2024-01-15"), new Date("2024-03-01")],
  });
  expect(result.map(r => r.values.revenue?.value)).toEqual([100, null]);
  expect(extractFundamentalSeries(financials, definition("fundamental.freeCashFlow"))).toEqual([]);
  expect(extractFundamentalSeries(financials, definition("valuation.trailingPE"))).toEqual([]);
});

test("distinct financial periods sharing a publication date survive report clipping and chart projection", async () => {
  const result = await load(data([
    row("2023-12-31", { eps: 2, availableAt: "2025-03-01" }),
    row("2024-12-31", { eps: 0, availableAt: "2025-03-01" }),
  ]), true);
  expect(result.series[0]!.points.map(p => [p.periodLabel, p.value])).toEqual([
    ["Year ended 2023-12-31", 15], ["Year ended 2024-12-31", null],
  ]);
  const scene = buildCompositeChartScene(result.chart.series, [{ id: "main" }], { width: 80, height: 24 })!;
  expect(scene.panels[0]!.series[0]!.points.map(p => p.value)).toEqual([15]);
  expect(scene.cursorValues[0]!.value).toBeNull();
  const atPublication = alignTimeSeries(result.chart.series, { timeline: [new Date("2025-03-01")] });
  expect(Object.values(atPublication[0]!.values)[0]?.value).toBeNull();
});

test("a missing later currency cannot relabel or erase earlier monetary observations", async () => {
  const financials = data([
    row("2023-12-31", { totalRevenue: 100, currency: "USD" }),
    row("2024-12-31", { currency: "EUR" }),
  ]);
  financials.financialCurrency = "EUR";
  const missing = await load(financials);
  expect(missing.series[0]!.points.map(p => p.value)).toEqual([100, null]);
  expect(missing.series[0]!.unit).toBe("USD");
  expect(missing.series[0]!.points.map(p => p.provenance?.currency)).toEqual(["USD", "EUR"]);
  financials.annualStatements[1]!.totalRevenue = 120;
  const recovered = await load(financials);
  expect(recovered.series[0]!.points.map(p => p.value)).toEqual([null, 120]);
  expect(recovered.series[0]!.unit).toBe("EUR");
});
