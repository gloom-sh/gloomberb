import { describe, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { chartHeadless, chartResolutionDrop, economicChartDates, type ChartPaneModel } from "./headless";
import { setPairStudies } from "./studies";
import { buildCustomChartPreset, buildIntradayPriceChartPreset } from "./presets";
import { createTestHeadlessContext } from "../../../test-support/headless";
import { resetFuturesPriceUnits } from "../../../market-data/futures-contract";
import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";

const history = ["2026-08-27", "2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]
  .flatMap((date, day) => [0, 1].map((bar) => ({
    date: new Date(`${date}T13:${bar ? "35" : "30"}:00Z`),
    open: 100 + day, high: 102 + day, low: 99 + day, close: 101 + day, volume: 100,
  })));

function fixture() {
  const calls: Array<{ kind: string; start?: Date; end?: Date; range?: string; resolution?: string }> = [];
  const spec = buildIntradayPriceChartPreset("AAPL:NASDAQ");
  const context = createTestHeadlessContext({
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
    settings: { chartSpec: spec },
  });
  return { spec, context, calls, load: async (options = {}) => await chartHeadless("graph-intraday-price-pane").load({
    argument: "AAPL:NASDAQ", rawArgument: "AAPL:NASDAQ", symbols: ["AAPL:NASDAQ"], options,
  }, context) as ChartPaneModel };
}

test("an unavailable currency spread reaches headless errors even with normalized chart presentation", async () => {
  for (const currency of ["EUR", ""]) for (const transform of ["raw", "percent"] as const) {
    const quote = (symbol: string) => ({ symbol, price: 100, change: 0, changePercent: 0,
      currency: symbol === "TARGET" ? "USD" : currency, instrumentType: "EQUITY" as const,
      lastUpdated: Date.parse("2026-09-03T13:35:00Z") });
    const provider = createTestDataProvider({
      getTickerFinancials: async (symbol) => ({ quote: quote(symbol), annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getQuote: async (symbol) => quote(symbol),
      getQuoteMetadata: async (symbol) => ({ symbol, currency: quote(symbol).currency, instrumentType: "EQUITY", source: {} }),
      getDetailedPriceHistory: async () => history,
      getPriceHistoryForResolution: async () => history,
    });
    const spec = setPairStudies(buildCustomChartPreset("TARGET:NASDAQ:market.close,ACQUIRER:NASDAQ:market.close"), ["spread", "ratio"]);
    spec.viewport.dateWindow = { start: "2026-08-27", end: "2026-09-04" };
    spec.series = spec.series.map((series) => ({ ...series, transform }));
    const result = await chartHeadless("chart-composer-pane").load({
      argument: "TARGET:NASDAQ,ACQUIRER:NASDAQ", rawArgument: "TARGET:NASDAQ,ACQUIRER:NASDAQ", symbols: ["TARGET:NASDAQ", "ACQUIRER:NASDAQ"], options: {},
    }, { ...fixture().context, marketData: provider, settings: { chartSpec: spec } });
    expect(result.errors).toEqual(["pair:spread: TARGET has no known unit and ACQUIRER has no known unit: a spread needs both in one known unit."]);
    expect(result.unavailableSymbols).toEqual([]);
    expect(result.series.map(({ id }) => id)).toEqual([...spec.series.map(({ id }) => id), "pair:ratio"]);
    expect(result.series.every(({ points }) => points.length > 0)).toBe(true);
  }
});

test("fn G 42*HO=F - CL=F charts the heating-oil crack per barrel, in the units the contracts trade in", async () => {
  resetFuturesPriceUnits();
  const closes: Record<string, number[]> = { "HO=F": [2.5, 2.6, 2.4], "CL=F": [70, 71, 72] };
  const days = ["2026-09-01", "2026-09-02", "2026-09-03"];
  const bars = (symbol: string) => days.map((day, index) => {
    const close = closes[symbol]![index]!;
    return { date: new Date(`${day}T00:00:00Z`), open: close, high: close, low: close, close, volume: 10 };
  });
  const quote = (symbol: string) => ({ symbol, price: closes[symbol]!.at(-1)!, change: 0, changePercent: 0, currency: "USD",
    instrumentType: "FUTURE" as const, lastUpdated: Date.parse("2026-09-03T20:00:00Z") });
  const terms = (symbol: string): FuturesContractTermsPayload => ({
    symbol, root: symbol.slice(0, 2), name: symbol, contract: null, contractSymbol: null, deliveryMonth: null,
    spec: { unit: symbol === "HO=F" ? "USD / gallon" : "USD / barrel", size: "", pointValue: 1, tick: 0.01, tickValue: 0.01, settlement: "physical" },
    lastTrade: null, firstNotice: null, inDelivery: false, settlement: null,
  });
  const marketData = createTestDataProvider({
    getTickerFinancials: async (symbol) => ({ quote: quote(symbol), annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getQuote: async (symbol) => quote(symbol),
    getQuoteMetadata: async (symbol) => ({ symbol, currency: "USD", instrumentType: "FUTURE", source: {} }),
    getDetailedPriceHistory: async (symbol) => bars(symbol),
    getPriceHistoryForResolution: async (symbol) => bars(symbol),
  });
  // The chart G opens for the argument.
  const chartSpec = buildCustomChartPreset("42*HO=F - CL=F");
  chartSpec.viewport.dateWindow = { start: "2026-09-01", end: "2026-09-04" };
  try {
    const result = await chartHeadless("chart-composer-pane").load({
      argument: "42*HO=F - CL=F", rawArgument: "42*HO=F - CL=F", symbols: [], options: {},
    }, createTestHeadlessContext({
      marketData,
      apiClient: { getCloudFuturesContract: async (symbol: string) => terms(symbol) } as never,
      settings: { chartSpec },
    })) as ChartPaneModel;
    expect(result.errors).toEqual([]);
    expect(result.series.map(({ label, unit }) => [label, unit])).toEqual([
      [expect.stringContaining("HO=F"), "USD / gallon"],
      [expect.stringContaining("CL=F"), "USD / barrel"],
      ["42×HO=F - CL=F", "USD / barrel"],
    ]);
    expect(result.series[2]!.points.map(({ value }) => value)).toEqual([35, 38.2, 28.8]);
  } finally {
    resetFuturesPriceUnits();
  }
});

test("a bar size the source does not serve for the range warns what came back and why, and each series names what it was asked as", async () => {
  const { applyChartComposerCapabilityOptions } = await import("./cli-options");
  const monthly = [{ date: new Date("2026-08-01T00:00:00Z"), open: 16.2, high: 16.6, low: 16.1, close: 16.4 },
    { date: new Date("2026-09-01T00:00:00Z"), open: 16.4, high: 16.7, low: 16.3, close: 16.5 }];
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getChartResolutionSupport: () => [{ resolution: "1d", maxRange: "5Y" }, { resolution: "1mo", maxRange: "ALL" }],
    getPriceHistoryForResolution: async (_symbol, _exchange, _range, resolution) => resolution === "1mo" ? monthly : [],
  });
  const spec = applyChartComposerCapabilityOptions(buildCustomChartPreset("USDZAR=X"), "chart-composer", { rangePreset: "ALL", chartResolution: "1d" });
  const result = await chartHeadless("chart-composer-pane").load(
    { argument: "USDZAR=X", rawArgument: "USDZAR=X", symbols: [], options: {} },
    { ...fixture().context, marketData: provider, settings: { chartSpec: spec } },
  );
  expect(result.warnings).toEqual(["1d is not available for ALL on USDZAR=X (1d bars go back 5Y at most); returning 1mo bars."]);
  expect(result.metadata?.resolution).toEqual({ requested: "1d", returned: "1mo", range: "ALL", reason: "1d bars go back 5Y at most" });
  expect(result.series[0]).toMatchObject({ symbol: "USDZAR=X", interval: "1mo" });
  // Bars served as asked, or none asked for, warn of nothing.
  const served = [{ historyResolution: "1d" as const, symbol: "USDZAR=X" }];
  expect(chartResolutionDrop("1d", { range: "5Y" }, served, [])).toBeNull();
  expect(chartResolutionDrop("auto", { range: "ALL" }, [{ historyResolution: "1mo", symbol: "USDZAR=X" }], [])).toBeNull();
  // Without a support list the source's answer is the reason.
  expect(chartResolutionDrop("1d", { range: "ALL" }, [{ historyResolution: "1wk", symbol: "USDNGN=X" }], [])?.warning)
    .toBe("1d is not available for ALL on USDNGN=X (the source returned 1wk bars); returning 1wk bars.");
});

test("a chart of monthly bars dates the report by how far its newest month has run, not by the 1st", async () => {
  const { applyChartComposerCapabilityOptions } = await import("./cli-options");
  const monthly = ["2026-08-01", "2026-09-01", "2026-10-01"].map((date) => ({ date: new Date(`${date}T00:00:00Z`), open: 16, high: 17, low: 15, close: 16.5 }));
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getChartResolutionSupport: () => [{ resolution: "1mo", maxRange: "ALL" }],
    getPriceHistoryForResolution: async () => monthly,
  });
  const spec = applyChartComposerCapabilityOptions(buildCustomChartPreset("USDZAR=X"), "chart-composer", { rangePreset: "ALL", chartResolution: "1mo" });
  const load = async () => await chartHeadless("chart-composer-pane").load(
    { argument: "USDZAR=X", rawArgument: "USDZAR=X", symbols: [], options: {} },
    { ...fixture().context, marketData: provider, settings: { chartSpec: spec } },
  );
  try {
    // Fri 16 Oct 2026: October's bar is still forming. Once the month has ended it is complete.
    setSystemTime(new Date("2026-10-16T08:14:00Z"));
    expect((await load()).freshness).toMatchObject({ basis: "monthly bars", periodToDate: { period: "month" } });
    setSystemTime(new Date("2026-11-03T08:14:00Z"));
    expect((await load()).freshness).not.toHaveProperty("periodToDate");
  } finally {
    setSystemTime();
  }
});

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
  expect(full.series[0]!.points[0]!.observedAt).toEqual(new Date("2017-06-30T00:00:00.000Z"));
  expect(full.complete).toBe(true);
  expect(full.metadata?.periodCoverage).toEqual([expect.objectContaining({ requested: 10, returned: 10, complete: true })]);
  const partial = await chartHeadless("fundamental-graph-pane").load(args, { ...context, marketData: createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: actual.cloudAnnual, quarterlyStatements: [], priceHistory: [] }),
  }) });
  expect(partial.series[0]!.points).toHaveLength(5);
  expect(partial.series[0]!.points.filter((point) => point.value !== null)).toHaveLength(4);
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

test("an economic chart is dated by its observations' day, and by their period when every series shares one", () => {
  const months = (count: number, last: string) => Array.from({ length: count }, (_, index) => {
    const date = new Date(`${last}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - (count - 1 - index));
    return { date: date.toISOString(), value: 300 + index };
  });
  const days = ["2026-10-07", "2026-10-08", "2026-10-09"].map((date) => ({ date: `${date}T00:00:00.000Z`, value: 4 }));
  const fred = (...ids: string[]) => ({ series: ids.map((seriesId) => ({ source: { kind: "economic" as const, provider: "fred" as const, seriesId } })) }) as never;
  const cpi = { id: "cpi", label: "CPI", points: [...months(24, "2026-08-01"), { date: "2026-09-01T00:00:00.000Z", value: null }] };
  expect(economicChartDates([cpi], fred("CPIAUCSL"))).toEqual({ asOf: "2026-08-01", periodicity: "monthly" });
  const gdp = { id: "gdp", label: "GDP", points: ["2025-04-01", "2025-07-01", "2025-10-01", "2026-01-01", "2026-04-01"].map((date) => ({ date, value: 1 })) };
  expect(economicChartDates([gdp], fred("GDP"))).toEqual({ asOf: "2026-04-01", periodicity: "quarterly" });
  // A daily series is dated by its day; series that end apart name the oldest, and mixed periods name none.
  expect(economicChartDates([cpi, { id: "dgs10", label: "10Y", points: days }], fred("CPIAUCSL", "DGS10")))
    .toEqual({ asOf: "2026-10-09", oldest: "2026-08-01" });
  // An observation time, or any series that is not economic, keeps the chart's own dating.
  expect(economicChartDates([{ id: "x", label: "x", points: [{ date: "2026-10-09T20:00:00.000Z", value: 1 }] }], fred("X"))).toEqual({});
  expect(economicChartDates([cpi], { series: [{ source: { kind: "capability", capabilityId: "c", seriesId: "s" } }] } as never)).toEqual({});
});
