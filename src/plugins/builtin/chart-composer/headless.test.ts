import { describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext } from "../../../types/headless";
import { chartHeadless, type ChartPaneModel } from "./headless";
import { buildIntradayPriceChartPreset } from "./presets";

const history = ["2026-08-27", "2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]
  .flatMap((date, day) => [0, 1].map((bar) => ({
    date: new Date(`${date}T13:${bar ? "35" : "30"}:00Z`),
    open: 100 + day, high: 102 + day, low: 99 + day, close: 101 + day, volume: 100,
  })));

function fixture() {
  const calls: Array<{ kind: string; start?: Date; end?: Date; range?: string; resolution?: string }> = [];
  const spec = buildIntradayPriceChartPreset("AAPL:NASDAQ");
  const context: HeadlessPaneContext = {
    marketData: createTestDataProvider({
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getQuote: async () => ({ symbol: "AAPL", price: 106, change: 0, changePercent: 0, currency: "USD", lastUpdated: Date.now() }),
      getPriceHistoryForResolution: async (_symbol, _exchange, range, resolution) => {
        calls.push({ kind: "trailing", range, resolution });
        return history;
      },
      getDetailedPriceHistory: async (_symbol, _exchange, start, end, resolution) => {
        calls.push({ kind: "detailed", start, end, resolution });
        return history.filter((point) => point.date >= start && point.date < end);
      },
    }),
    apiClient: {} as HeadlessPaneContext["apiClient"],
    config: createDefaultConfig("/tmp/gloom-headless-chart"),
    signal: new AbortController().signal,
    settings: { chartSpec: spec },
  };
  return { spec, context, calls, load: async (options = {}) => await chartHeadless("graph-intraday-price-pane").load({
    argument: "AAPL:NASDAQ", rawArgument: "AAPL:NASDAQ", symbols: ["AAPL:NASDAQ"], options,
  }, context) as ChartPaneModel };
}

describe("GIP headless sessions", () => {
  test("selects the latest one/five sessions or a historical session, retaining its last bar without another history fetch", async () => {
    for (const [range, session, days] of [["1D", undefined, 1], ["1W", undefined, 5], ["1W", "2026-09-01", 1]] as const) {
      const { spec, calls, load } = fixture();
      spec.viewport.range = range;
      spec.viewport.resolution = "auto";
      const result = await load(session ? { session } : {});
      const points = result.chart.series[0]!.points;
      expect(result.errors).toEqual([]);
      expect(points).toHaveLength(days * 2);
      expect(points.at(-1)?.date.toISOString()).toBe(`${session ?? "2026-09-03"}T13:35:00.000Z`);
      expect(calls).toHaveLength(1);
      if (session) expect(calls[0]).toEqual({ kind: "detailed", start: new Date("2026-09-01T04:00:00Z"), end: new Date("2026-09-02T04:00:00Z"), resolution: "1m" });
    }
  });

  test("retains explicit chart windows and reports unavailable sessions instead of substituting daily data", async () => {
    const { spec, calls, load } = fixture();
    spec.viewport.dateWindow = { start: "2026-08-28T13:30:00Z", end: "2026-08-31T13:35:00Z" };
    const explicit = await load();
    expect(explicit.chart.series[0]!.points).toHaveLength(4);
    expect(explicit.metadata?.viewport).toEqual(spec.viewport);
    expect(calls.every((call) => call.kind === "detailed")).toBe(true);

    const missing = await fixture().load({ session: "2020-01-02" });
    expect(missing.chart.series[0]?.points ?? []).toEqual([]);
    expect(missing.errors?.some((error) => error.includes("No intraday price history is available for AAPL for session 2020-01-02."))).toBe(true);
    expect(missing.unavailableSymbols).toEqual(["AAPL:XNAS"]);
  });
});

test("chart reports retain raw comparison endpoints and growth preceding a financial observation limit", async () => {
  const { buildComparisonChartPreset, buildFundamentalChartPreset } = await import("./presets");
  const { applyChartComposerCapabilityOptions } = await import("./cli-options");
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({
      annualStatements: [{ date: "2024-12-31", totalRevenue: 100 }, { date: "2025-12-31", totalRevenue: 150 }],
      quarterlyStatements: [], priceHistory: [],
    }),
    getPriceHistoryForResolution: async () => [
      { date: new Date("2026-08-01"), close: 100 },
      { date: new Date("2026-09-01"), close: 120 },
    ],
  });
  const context = { ...fixture().context, marketData: provider };
  const comparison = buildComparisonChartPreset(["AAPL:NASDAQ", "MSFT:NASDAQ"]);
  const args = { argument: ["AAPL:NASDAQ", "MSFT:NASDAQ"], rawArgument: "AAPL:NASDAQ,MSFT:NASDAQ", symbols: ["AAPL:NASDAQ", "MSFT:NASDAQ"], options: {} };
  const result = await chartHeadless("comparison-chart-pane").load(args, { ...context, settings: { chartSpec: comparison } });
  expect(result.series[0]!.points.map(({ value }) => value)).toEqual([0, 20]);
  expect(result.series[0]!.points.map(({ rawValue }) => rawValue)).toEqual([100, 120]);
  expect(result.metadata?.summaries).toEqual(expect.arrayContaining([
    expect.objectContaining({ startValue: 100, endValue: 120, return: 0.2 }),
  ]));

  const options = { metric: "totalRevenue", period: "annual", periods: 1 };
  const spec = applyChartComposerCapabilityOptions(buildFundamentalChartPreset(["AAPL:NASDAQ"]), "fundamental-series", options);
  const financial = await chartHeadless("fundamental-graph-pane").load({ ...args, options }, { ...context, settings: { chartSpec: spec } });
  expect(financial.series[0]!.points).toHaveLength(1);
  expect(financial.series[0]!.points[0]).toMatchObject({ value: 150, growth: 0.5 });
});

test("explicit financial periods replay available SEC history and expose actual cloud depth deficits", async () => {
  const actual = await import("./financial-periods.fixture.json");
  const { buildFundamentalChartPreset } = await import("./presets");
  const { applyChartComposerCapabilityOptions } = await import("./cli-options");
  const options = { metric: "operatingMargin", period: "annual", periods: 10 };
  const spec = applyChartComposerCapabilityOptions(buildFundamentalChartPreset(["MSFT"]), "fundamental-series", options);
  const context = { ...fixture().context, settings: { chartSpec: spec }, marketData: createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: actual.secAnnual, quarterlyStatements: [], priceHistory: [] }),
  }) };
  const args = { argument: ["MSFT"], rawArgument: "MSFT", symbols: ["MSFT"], options };
  const full = await chartHeadless("fundamental-graph-pane").load(args, context);
  expect(spec.viewport.range).toBe("ALL");
  expect(full.series[0]!.points).toHaveLength(10);
  expect(full.series[0]!.points[0]!.observedAt.toISOString()).toBe("2017-06-30T00:00:00.000Z");
  expect(full.complete).toBe(true);
  expect(full.metadata?.periodCoverage).toEqual([expect.objectContaining({ requested: 10, returned: 10, complete: true })]);
  const partial = await chartHeadless("fundamental-graph-pane").load(args, { ...context, marketData: createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: actual.cloudAnnual, quarterlyStatements: [], priceHistory: [] }),
  }) });
  expect(partial.series[0]!.points).toHaveLength(4);
  expect(partial.complete).toBe(false);
  expect(partial.unavailableSymbols).toEqual([]);
  expect(partial.metadata?.periodCoverage).toEqual([expect.objectContaining({ requested: 10, returned: 4, complete: false })]);
  expect((partial as ChartPaneModel).chart.warnings.join(" ")).toContain("4 of 10 requested annual observations");
  const constrained = applyChartComposerCapabilityOptions({ ...spec, viewport: { ...spec.viewport,
    dateWindow: { start: "2024-01-01", end: "2025-12-31" } } }, "fundamental-series", options);
  const windowed = await chartHeadless("fundamental-graph-pane").load(args, { ...context, settings: { chartSpec: constrained } });
  expect(windowed.series[0]!.points).toHaveLength(2);
  expect(windowed.complete).toBe(false);
  const explicitRange = applyChartComposerCapabilityOptions(spec, "fundamental-series", { ...options, rangePreset: "1Y" });
  expect(explicitRange.viewport.range).toBe("1Y");
});
