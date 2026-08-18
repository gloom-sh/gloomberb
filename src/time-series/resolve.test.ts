import { describe, expect, test } from "bun:test";
import type { FredSeriesData, FredSeriesLoadResult } from "../data/fred-series";
import { createTestDataProvider } from "../test-support/data-provider";
import type { TickerFinancials } from "../types/financials";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";
import { ChartResolveCache, mergePriceHistoryWindows, resolveChartSpecData } from "./resolve";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { chartSeriesSourceKey } from "../capabilities";
import { buildCustomChartPreset } from "../plugins/builtin/chart-composer/presets";

const emptyFinancials = (): TickerFinancials => ({
  annualStatements: [],
  quarterlyStatements: [],
  priceHistory: [],
});

const fredLoad = (
  data: FredSeriesData = { observations: [], info: null },
  overrides: Partial<FredSeriesLoadResult> = {},
): FredSeriesLoadResult => ({
  data,
  fetchedAt: Date.parse("2026-03-01T00:00:00Z"),
  stale: false,
  source: "network",
  ...overrides,
});

describe("resolveChartSpecData", () => {
  test("routes futures and Treasury aliases through the existing market and FRED pipelines", async () => {
    const marketRequests: string[] = [];
    const fredRequests: string[] = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getPriceHistoryForResolution: async (symbol) => {
        marketRequests.push(symbol);
        return [{ date: new Date("2026-02-01T00:00:00Z"), close: 6_100 }];
      },
    });

    const result = await resolveChartSpecData(
      buildCustomChartPreset("FUT:ES, UST:10Y"),
      {
        dataProvider: provider,
        now: new Date("2026-03-01T00:00:00Z"),
        loadFredSeries: async ({ seriesId }) => {
          fredRequests.push(seriesId);
          return fredLoad({
            observations: [{ date: "2026-02-01", value: 4.25 }],
            info: null,
          });
        },
      },
    );

    expect(result.errors).toEqual([]);
    expect(marketRequests).toEqual(["ES=F"]);
    expect(fredRequests).toEqual(["DGS10"]);
    expect(result.series.map((series) => series.points[0]?.value ?? series.points[0]?.close))
      .toEqual([6_100, 4.25]);
  });

  test("keeps missing capability series visible with a useful error and resolves them through the injected boundary", async () => {
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1M", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "plugin-series",
        source: { kind: "capability", capabilityId: "charts.test", seriesId: "one" },
        style: "area",
        transform: "raw",
        axis: "auto",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };
    const sources = { dataProvider: null, loadFredSeries: async () => fredLoad(), now: new Date("2026-02-01") };
    const missing = await resolveChartSpecData(spec, sources);
    expect(missing.series).toHaveLength(1);
    expect(missing.series[0]?.points).toEqual([]);
    expect(missing.errors[0]).toContain('Chart series capability "charts.test" is unavailable');

    const resolved = await resolveChartSpecData(spec, {
      ...sources,
      resolveCapabilitySeries: async () => ({
        id: "provider-id",
        label: "Provider Label",
        color: "#fff",
        unit: "value",
        unitGroup: "value",
        nativeFrequency: "daily",
        dataShape: "scalar",
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "provider",
        interpolation: "none",
        points: [{ date: new Date("2026-01-15"), observedAt: new Date("2026-01-15"), value: 42 }],
      }),
    });
    expect(resolved.errors).toEqual([]);
    expect(resolved.series[0]).toMatchObject({ id: "plugin-series", style: "area", panelId: "main" });
    expect(resolved.series[0]?.points[0]?.value).toBe(42);
  });

  test("resolves capability coverage for each effective panned viewport and caches by structured bounds", async () => {
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1M", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "plugin-series",
        source: { kind: "capability", capabilityId: "charts.test", seriesId: "provider/series" },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };
    const requested: ChartSpec["viewport"][] = [];
    const cache = new ChartResolveCache();
    const sources = {
      dataProvider: null,
      loadFredSeries: async () => fredLoad(),
      now: new Date("2026-03-01T00:00:00.000Z"),
      resolveCapabilitySeries: async (_source: any, viewport: ChartSpec["viewport"]) => {
        requested.push(viewport);
        const date = new Date(viewport.dateWindow!.start);
        return {
          id: "provider",
          label: "Provider",
          color: "#ffffff",
          unit: "value",
          unitGroup: "value",
          nativeFrequency: "daily" as const,
          dataShape: "scalar" as const,
          style: "line" as const,
          transform: "raw" as const,
          axis: "left" as const,
          panelId: "main",
          interpolation: "none" as const,
          points: [{ date, observedAt: date, value: 1 }],
        };
      },
    };
    const firstViewport = { start: new Date("2026-01-01T00:00:00.000Z"), end: new Date("2026-01-08T00:00:00.000Z") };
    const secondViewport = { start: new Date("2026-02-01T00:00:00.000Z"), end: new Date("2026-02-08T00:00:00.000Z") };

    await resolveChartSpecData(spec, sources, cache, { requestViewport: firstViewport });
    const panned = await resolveChartSpecData(spec, sources, cache, { requestViewport: secondViewport });
    await resolveChartSpecData(spec, sources, cache, { requestViewport: firstViewport });

    expect(panned.series[0]?.points[0]?.date.toISOString()).toBe(secondViewport.start.toISOString());
    expect(panned.viewport).toEqual(secondViewport);
    expect(requested.map((viewport) => viewport.dateWindow)).toEqual([
      { start: firstViewport.start.toISOString(), end: firstViewport.end.toISOString() },
      { start: secondViewport.start.toISOString(), end: secondViewport.end.toISOString() },
    ]);
    expect(chartSeriesSourceKey({ kind: "capability", capabilityId: "a", seriesId: "b:c" }))
      .not.toBe(chartSeriesSourceKey({ kind: "capability", capabilityId: "a-b", seriesId: "c" }));
  });

  test("derives Auto fetch resolution from the finest explicit market period", async () => {
    const cases = [
      { range: "ALL" as const, periods: ["daily", "monthly"] as const, expected: "1d" },
      { range: "ALL" as const, periods: ["weekly", "monthly"] as const, expected: "1wk" },
      { range: "1Y" as const, periods: ["monthly"] as const, expected: "1d" },
    ];

    for (const scenario of cases) {
      const requestedResolutions: string[] = [];
      const provider = createTestDataProvider({
        getTickerFinancials: async () => emptyFinancials(),
        getPriceHistoryForResolution: async (_symbol, _exchange, _range, resolution) => {
          requestedResolutions.push(resolution);
          return [{ date: new Date("2025-01-07T16:00:00Z"), close: 100 }];
        },
      });
      const spec: ChartSpec = {
        version: CHART_SPEC_VERSION,
        viewport: { range: scenario.range, resolution: "auto" },
        panels: [{ id: "main" }],
        series: scenario.periods.map((period, index) => ({
          id: `price-${index}`,
          source: {
            kind: "security" as const,
            instrument: { symbol: `TEST${index}` },
            fieldId: "market.close",
            period,
          },
          style: "line" as const,
          transform: "raw" as const,
          axis: "left" as const,
          panelId: "main",
          interpolation: "none" as const,
        })),
        studies: [],
      };

      const result = await resolveChartSpecData(spec, {
        dataProvider: provider,
        now: new Date("2025-01-08T00:00:00Z"),
        loadFredSeries: async () => fredLoad(),
      });

      expect(result.errors).toEqual([]);
      expect(new Set(requestedResolutions)).toEqual(new Set([scenario.expected]));
    }
  });

  test("does not relabel provider-default history as a manually requested resolution", async () => {
    let genericHistoryCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getPriceHistoryForResolution: async () => [],
      getPriceHistory: async () => {
        genericHistoryCalls += 1;
        return [{ date: new Date("2025-01-07T16:00:00Z"), close: 100 }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1W", resolution: "5m" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2025-01-08T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(genericHistoryCalls).toBe(0);
    // The series keeps its legend slot with no observations so the chart and the
    // series editor agree on what the user added.
    expect(result.series.map((entry) => [entry.id, entry.points.length])).toEqual([["price", 0]]);
    expect(result.errors).toEqual([
      "price: Requested 5m price history is unavailable for TEST. Choose Auto or a supported interval.",
    ]);
  });

  test("falls back from an unsupported manual interval while exposing source capabilities", async () => {
    const requestedResolutions: string[] = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: () => [
        { resolution: "15m", maxRange: "1M" },
        { resolution: "1h", maxRange: "3M" },
      ],
      getPriceHistoryForResolution: async (_symbol, _exchange, _range, resolution) => {
        requestedResolutions.push(resolution);
        return [{ date: new Date("2026-07-30T15:00:00Z"), close: 100 }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1M", resolution: "45m" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2026-07-30T16:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(requestedResolutions).toEqual(["15m"]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain(
      "45M data is unavailable for this range. Auto resolution was used instead.",
    );
    expect(result.resolutionSupport).toEqual([
      { resolution: "15m", maxRange: "1M" },
      { resolution: "1h", maxRange: "3M" },
    ]);
  });

  test("keeps the snapshot exchange when a newer quote omits it", async () => {
    const historyExchanges: string[] = [];
    const source = {
      kind: "security" as const,
      instrument: { symbol: "SNDK" },
      fieldId: "market.ohlcv",
    };
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({
        ...emptyFinancials(),
        quote: {
          symbol: "SNDK",
          price: 1_240,
          currency: "USD",
          change: 20,
          changePercent: 1.64,
          lastUpdated: Date.parse("2026-07-30T15:25:00Z"),
          listingExchangeName: "XNAS",
        },
      }),
      getPriceHistoryForResolution: async (_symbol, exchange) => {
        historyExchanges.push(exchange);
        return [{
          date: new Date("2026-07-30T15:20:00Z"),
          open: 1_235,
          high: 1_242,
          low: 1_233,
          close: 1_240,
        }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1D", resolution: "5m" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source,
        style: "candles",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2026-07-30T15:30:00Z"),
      quoteOverrides: new Map([[
        chartQuoteOverrideKeyForSource(source),
        {
          symbol: "SNDK",
          price: 1_245,
          currency: "USD",
          change: 25,
          changePercent: 2.05,
          lastUpdated: Date.parse("2026-07-30T15:26:00Z"),
        },
      ]]),
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    expect(historyExchanges).toEqual(["XNAS"]);
    expect(result.series[0]?.points.at(-1)?.date.toISOString())
      .toBe("2026-07-30T15:26:00.000Z");
    expect(result.series[0]?.timeBasis).toMatchObject({
      kind: "market",
      timeZone: "America/New_York",
      cadenceMs: 5 * 60_000,
    });
  });

  test("resolves the exchange before selecting an adaptive Auto resolution", async () => {
    const supportExchanges: string[] = [];
    const historyRequests: Array<{ exchange: string; resolution: string }> = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({
        ...emptyFinancials(),
        quote: {
          symbol: "SNDK",
          price: 1_240,
          currency: "USD",
          change: 20,
          changePercent: 1.64,
          lastUpdated: Date.parse("2026-07-30T15:25:00Z"),
          listingExchangeName: "XNAS",
        },
      }),
      getChartResolutionSupport: (_symbol, exchange) => {
        supportExchanges.push(exchange);
        return exchange === "XNAS"
          ? [{ resolution: "5m", maxRange: "1W" }]
          : [{ resolution: "1d", maxRange: "5Y" }];
      },
      getDetailedPriceHistory: async (_symbol, exchange, _start, _end, resolution) => {
        historyRequests.push({ exchange, resolution });
        return [{ date: new Date("2026-07-30T15:20:00Z"), close: 1_240 }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1D", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "SNDK" },
          fieldId: "market.close",
        },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(
      spec,
      {
        dataProvider: provider,
        now: new Date("2026-07-30T15:30:00Z"),
        loadFredSeries: async () => fredLoad(),
      },
      new ChartResolveCache(),
      {
        autoViewport: {
          start: new Date("2026-07-30T09:30:00Z"),
          end: new Date("2026-07-30T15:30:00Z"),
        },
        targetPointCount: 100,
      },
    );

    expect(result.errors).toEqual([]);
    expect(supportExchanges).toEqual(["XNAS"]);
    expect(historyRequests).toEqual([{ exchange: "XNAS", resolution: "5m" }]);
  });

  test("uses provider-default history as a valid fallback for Auto resolution", async () => {
    let genericHistoryCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getPriceHistoryForResolution: async () => {
        throw new Error("5m is unavailable");
      },
      getPriceHistory: async () => {
        genericHistoryCalls += 1;
        return [{ date: new Date("2025-01-07T16:00:00Z"), close: 100 }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1W", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2025-01-08T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(genericHistoryCalls).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.series[0]?.points.map((point) => point.value)).toEqual([100]);
  });

  test("clamps preload history to the provider limit without coarsening the visible interval", async () => {
    const requests: Array<{ range: string; resolution: string }> = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: () => [{ resolution: "5m", maxRange: "1W" }],
      getPriceHistoryForResolution: async (_symbol, _exchange, range, resolution) => {
        requests.push({ range, resolution });
        return [{ date: new Date("2025-01-07T16:00:00Z"), close: 100 }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1W", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2025-01-08T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    expect(requests).toEqual([{ range: "1W", resolution: "5m" }]);
  });

  test("keeps Auto zoom selection while loading a separately panned history window", async () => {
    const detailedRequests: Array<{
      start: string;
      end: string;
      resolution: string;
    }> = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: () => [
        { resolution: "15m", maxRange: "1M" },
        { resolution: "1h", maxRange: "6M" },
        { resolution: "1d", maxRange: "5Y" },
      ],
      getDetailedPriceHistory: async (_symbol, _exchange, start, end, resolution) => {
        detailedRequests.push({
          start: start.toISOString(),
          end: end.toISOString(),
          resolution,
        });
        return [{ date: new Date("2025-01-15T16:00:00.000Z"), close: 100 }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "3M", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(
      spec,
      {
        dataProvider: provider,
        now: new Date("2025-04-01T00:00:00.000Z"),
        loadFredSeries: async () => fredLoad(),
      },
      new ChartResolveCache(),
      {
        autoViewport: {
          start: new Date("2025-03-10T00:00:00.000Z"),
          end: new Date("2025-03-17T00:00:00.000Z"),
        },
        requestViewport: {
          start: new Date("2025-01-10T00:00:00.000Z"),
          end: new Date("2025-01-17T00:00:00.000Z"),
        },
        targetPointCount: 100,
      },
    );

    expect(spec.viewport.resolution).toBe("auto");
    expect(detailedRequests).toHaveLength(1);
    expect(detailedRequests[0]?.resolution).toBe("15m");
    expect(detailedRequests[0]?.end).toBe("2025-01-17T00:00:00.001Z");
    expect(result.viewport?.start.toISOString()).toBe("2025-01-10T00:00:00.000Z");
    expect(result.viewport?.end.toISOString()).toBe("2025-01-17T00:00:00.000Z");
    expect(result.series[0]?.timeBasis).toMatchObject({
      kind: "market",
      timeZone: "America/New_York",
      cadenceMs: 15 * 60 * 1_000,
    });
  });

  test("accumulates historical windows without replacing the current tail", async () => {
    const detailedRequests: Array<{ start: string; end: string }> = [];
    const currentHistory = [
      { date: "2026-01-02T16:00:00.000Z" as unknown as Date, close: 110 },
      { date: new Date("2026-07-30T16:00:00.000Z"), close: 120 },
    ];
    const historicalHistory = [
      { date: new Date("2024-08-01T16:00:00.000Z"), close: 90 },
      { date: new Date("2025-07-29T16:00:00.000Z"), close: 100 },
    ];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: () => [
        { resolution: "1h", maxRange: "1Y" },
        { resolution: "1d", maxRange: "ALL" },
      ],
      getPriceHistoryForResolution: async () => currentHistory,
      getDetailedPriceHistory: async (_symbol, _exchange, start, end) => {
        detailedRequests.push({
          start: start.toISOString(),
          end: end.toISOString(),
        });
        return historicalHistory;
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1h" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };
    const sources = {
      dataProvider: provider,
      now: new Date("2026-07-30T16:00:00.000Z"),
      loadFredSeries: async () => fredLoad(),
    };
    const cache = new ChartResolveCache();

    const current = await resolveChartSpecData(spec, sources, cache);
    const historical = await resolveChartSpecData(spec, sources, cache, {
      requestViewport: {
        start: new Date("2024-07-30T16:00:00.000Z"),
        end: new Date("2025-07-30T16:00:00.000Z"),
      },
    });
    const revisitedCurrent = await resolveChartSpecData(spec, sources, cache);
    const bufferedDates = (result: typeof current) => (
      result.bufferedSeries?.[0]?.points.map((point) => point.date.toISOString())
    );

    expect(detailedRequests).toEqual([{
      start: "2024-07-30T16:00:00.000Z",
      end: "2025-07-30T16:00:00.001Z",
    }]);
    expect(current.resolutionSupport).toEqual([
      { resolution: "1h", maxRange: "1Y" },
      { resolution: "1d", maxRange: "ALL" },
    ]);
    expect(bufferedDates(historical)).toEqual([
      "2024-08-01T16:00:00.000Z",
      "2025-07-29T16:00:00.000Z",
      "2026-01-02T16:00:00.000Z",
      "2026-07-30T16:00:00.000Z",
    ]);
    expect(bufferedDates(revisitedCurrent)).toEqual(bufferedDates(historical));
    expect(revisitedCurrent.bufferedSeries?.[0]?.points.at(-1)?.value).toBe(120);
  });

  test("keeps one daily bar per session when windows come from sources that stamp bars differently", async () => {
    // The trailing window is stamped at the opening bell, the panned window at
    // local midnight, so the same sessions arrive with timestamps hours apart.
    const currentHistory = [
      { date: new Date("2026-07-28T13:30:00.000Z"), close: 110 },
      { date: new Date("2026-07-29T13:30:00.000Z"), close: 115 },
      { date: new Date("2026-07-30T13:30:00.000Z"), close: 120 },
    ];
    const historicalHistory = [
      { date: new Date("2026-07-23T22:00:00.000Z"), close: 100 },
      { date: new Date("2026-07-27T22:00:00.000Z"), close: 111 },
      { date: new Date("2026-07-28T22:00:00.000Z"), close: 116 },
      { date: new Date("2026-07-29T22:00:00.000Z"), close: 121 },
    ];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: () => [{ resolution: "1d", maxRange: "ALL" }],
      getPriceHistoryForResolution: async () => currentHistory,
      getDetailedPriceHistory: async () => historicalHistory,
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };
    const sources = {
      dataProvider: provider,
      now: new Date("2026-07-30T16:00:00.000Z"),
      loadFredSeries: async () => fredLoad(),
    };
    const cache = new ChartResolveCache();

    await resolveChartSpecData(spec, sources, cache);
    const panned = await resolveChartSpecData(spec, sources, cache, {
      requestViewport: {
        start: new Date("2026-07-20T00:00:00.000Z"),
        end: new Date("2026-07-30T16:00:00.000Z"),
      },
    });

    const points = panned.bufferedSeries?.[0]?.points ?? [];
    expect(points.map((point) => point.date.toISOString())).toEqual([
      "2026-07-23T22:00:00.000Z",
      "2026-07-28T13:30:00.000Z",
      "2026-07-29T13:30:00.000Z",
      "2026-07-30T13:30:00.000Z",
    ]);
    expect(points.map((point) => point.value)).toEqual([100, 110, 115, 120]);
  });

  test("keeps percent transforms and studies defined in a panned history window", async () => {
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getDetailedPriceHistory: async () => [
        { date: new Date("2024-10-15T16:00:00.000Z"), close: 100 },
        { date: new Date("2024-10-16T16:00:00.000Z"), close: 110 },
      ],
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "3M", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
        style: "line",
        transform: "percent",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 2 },
        panelId: "main",
        axis: "left",
      }],
    };

    const result = await resolveChartSpecData(
      spec,
      {
        dataProvider: provider,
        now: new Date("2025-04-01T00:00:00.000Z"),
        loadFredSeries: async () => fredLoad(),
      },
      new ChartResolveCache(),
      {
        requestViewport: {
          start: new Date("2024-10-10T00:00:00.000Z"),
          end: new Date("2024-10-17T00:00:00.000Z"),
        },
      },
    );

    expect(result.errors).toEqual([]);
    expect(result.bufferedSeries?.find((series) => series.id === "price")?.points.map((point) => point.value))
      .toEqual([0, 10]);
    expect(result.bufferedSeries?.find((series) => series.id === "sma")?.points.map((point) => point.value))
      .toEqual([5]);
  });

  test("resolves unrelated price, filed fundamental, and economic series on one chart", async () => {
    const provider = createTestDataProvider({
      getTickerFinancials: async (symbol) => symbol === "MSFT"
        ? {
          ...emptyFinancials(),
          annualStatements: [{
            date: "2025-12-31",
            availableAt: "2026-02-15",
            fieldAvailability: { totalRevenue: "2026-02-15" },
            totalRevenue: 250,
          }],
        }
        : emptyFinancials(),
      getPriceHistoryForResolution: async (symbol, _exchange, _range, resolution) => {
        expect(symbol).toBe("AAPL");
        expect(resolution).toBe("1d");
        return [
          { date: new Date("2024-12-31T00:00:00Z"), close: 80 },
          { date: new Date("2025-04-01T00:00:00Z"), close: 100 },
          { date: new Date("2026-03-01T00:00:00Z"), close: 125 },
        ];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }, { id: "macro", height: 0.4 }],
      series: [
        {
          id: "aapl-price",
          source: { kind: "security", instrument: { symbol: "AAPL" }, fieldId: "market.close" },
          style: "line",
          transform: "percent",
          axis: "auto",
          panelId: "main",
          interpolation: "none",
        },
        {
          id: "msft-revenue",
          source: {
            kind: "security",
            instrument: { symbol: "MSFT" },
            fieldId: "fundamental.totalRevenue",
            period: "annual",
            timestampMode: "available-at",
          },
          style: "columns",
          transform: "raw",
          axis: "auto",
          panelId: "main",
          interpolation: "step-after",
        },
        {
          id: "cpi",
          source: { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
          style: "step",
          transform: "raw",
          axis: "auto",
          panelId: "macro",
          interpolation: "step-after",
        },
      ],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2026-03-31T00:00:00Z"),
      loadFredSeries: async () => fredLoad({
        observations: [
          { date: "2025-03-01", value: 310 },
          { date: "2026-03-01", value: 320 },
        ],
        info: {
          id: "CPIAUCSL",
          title: "Consumer Price Index",
          units: "Index 1982-1984=100",
          frequency: "Monthly",
          seasonalAdjustment: "Seasonally Adjusted",
          source: "FRED",
          notes: "",
        },
      }, {
        fetchedAt: Date.parse("2026-03-15T00:00:00Z"),
        stale: true,
        source: "stale-fallback",
        refreshError: "network unavailable",
      }),
    });

    expect(result.errors).toEqual([]);
    expect(result.series).toHaveLength(3);
    const price = result.series.find((entry) => entry.id === "aapl-price")!;
    expect(price.points.map((point) => point.value)).toEqual([0, 25]);
    expect(price.axis).toBe("left");
    const bufferedPrice = result.bufferedSeries?.find((entry) => entry.id === "aapl-price");
    expect(bufferedPrice?.points.map((point) => point.value)).toEqual([-20, 0, 25]);
    const revenue = result.series.find((entry) => entry.id === "msft-revenue")!;
    expect(revenue.points[0]?.date.toISOString().slice(0, 10)).toBe("2026-02-15");
    expect(revenue.axis).toBe("right");
    expect(result.series.find((entry) => entry.id === "cpi")?.panelId).toBe("macro");
    expect(result.warnings[0]).toContain("FRED refresh failed (network unavailable)");
    expect(result.warnings[0]).toContain("cached data fetched 2026-03-15");
    expect(result.warnings.some((warning) => warning.includes("FRED vintage dates"))).toBe(true);
    expect(result.viewport).toEqual({
      start: new Date("2025-03-31T00:00:00.000Z"),
      end: new Date("2026-03-31T00:00:00.000Z"),
    });
  });

  test("uses an exact custom window, derives its auto resolution, and warms studies before clipping", async () => {
    let detailRequest: {
      start: Date;
      end: Date;
      barSize: string;
    } | null = null;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getDetailedPriceHistory: async (_symbol, _exchange, start, end, barSize) => {
        detailRequest = { start, end, barSize };
        return [
          { date: new Date("2024-12-30T16:00:00Z"), close: 10 },
          { date: new Date("2024-12-31T16:00:00Z"), close: 20 },
          { date: new Date("2025-01-01T16:00:00Z"), close: 30 },
          { date: new Date("2025-01-31T16:00:00Z"), close: 40 },
        ];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: {
        range: "1Y",
        resolution: "auto",
        dateWindow: { start: "2025-01-01", end: "2025-01-31" },
      },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 3 },
        panelId: "main",
        axis: "left",
      }],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2026-03-01T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(detailRequest).not.toBeNull();
    expect(detailRequest!.barSize).toBe("15m");
    expect(detailRequest!.start.getTime()).toBeLessThan(new Date("2025-01-01T00:00:00Z").getTime());
    expect(detailRequest!.end.toISOString()).toBe("2025-02-01T00:00:00.000Z");
    expect(result.series.find((entry) => entry.id === "price")?.points.map((point) => point.date.toISOString())).toEqual([
      "2025-01-01T16:00:00.000Z",
      "2025-01-31T16:00:00.000Z",
    ]);
    expect(result.series.find((entry) => entry.id === "sma")?.points.map((point) => point.value)).toEqual([20, 30]);
    expect(result.viewport).toEqual({
      start: new Date("2025-01-01T00:00:00.000Z"),
      end: new Date("2025-01-31T23:59:59.999Z"),
    });
  });

  test("falls back to a trailing range that reaches a historical custom window", async () => {
    let detailAttempted = false;
    let requestedRange = "";
    let requestedResolution = "";
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getDetailedPriceHistory: async () => {
        detailAttempted = true;
        return [];
      },
      getPriceHistoryForResolution: async (_symbol, _exchange, range, resolution) => {
        requestedRange = range;
        requestedResolution = resolution;
        return [{ date: new Date("2025-01-31T16:00:00Z"), close: 40 }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: {
        range: "1D",
        resolution: "auto",
        dateWindow: { start: "2025-01-01", end: "2025-01-31" },
      },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2026-03-01T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(detailAttempted).toBe(true);
    expect(requestedRange).toBe("5Y");
    expect(requestedResolution).toBe("15m");
    expect(result.series[0]?.points).toHaveLength(1);
  });

  test("retains the prior step observation as the custom window's left-edge anchor", async () => {
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({
        ...emptyFinancials(),
        annualStatements: [{
          date: "2024-09-30",
          availableAt: "2024-12-15",
          fieldAvailability: { totalRevenue: "2024-12-15" },
          totalRevenue: 90,
        }],
      }),
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: {
        range: "1M",
        resolution: "auto",
        dateWindow: { start: "2025-01-01", end: "2025-01-31" },
      },
      panels: [{ id: "main" }],
      series: [{
        id: "revenue",
        source: {
          kind: "security",
          instrument: { symbol: "TEST" },
          fieldId: "fundamental.totalRevenue",
          period: "annual",
          timestampMode: "available-at",
        },
        style: "step",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "step-after",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2025-02-01T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    const anchor = result.series[0]?.points[0];
    expect(result.series[0]?.points).toHaveLength(1);
    expect(anchor?.date.toISOString()).toBe("2024-12-15T00:00:00.000Z");
    expect(anchor?.value).toBe(90);
  });

  test("retains an as-of anchor for ratio and spread formulas across a custom window", async () => {
    const provider = createTestDataProvider({
      getTickerFinancials: async (symbol) => ({
        ...emptyFinancials(),
        quarterlyStatements: symbol === "LEFT"
          ? [
            {
              date: "2024-12-31",
              availableAt: "2025-02-10",
              fieldAvailability: { totalRevenue: "2025-02-10" },
              totalRevenue: 100,
            },
            {
              date: "2025-03-31",
              availableAt: "2025-05-10",
              fieldAvailability: { totalRevenue: "2025-05-10" },
              totalRevenue: 120,
            },
          ]
          : [
            {
              date: "2024-12-31",
              availableAt: "2025-02-20",
              fieldAvailability: { totalRevenue: "2025-02-20" },
              totalRevenue: 50,
            },
            {
              date: "2025-03-31",
              availableAt: "2025-06-10",
              fieldAvailability: { totalRevenue: "2025-06-10" },
              totalRevenue: 40,
            },
          ],
      }),
    });
    const fundamental = (id: string, symbol: string): ChartSpec["series"][number] => ({
      id,
      source: {
        kind: "security",
        instrument: { symbol },
        fieldId: "fundamental.totalRevenue",
        period: "quarterly",
        timestampMode: "available-at",
      },
      // The built-in fundamental comparison preset uses columns without
      // display interpolation; formula calculation still uses as-of values.
      style: "columns",
      transform: "raw",
      axis: "left",
      panelId: "main",
      interpolation: "none",
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: {
        range: "1Y",
        resolution: "auto",
        dateWindow: { start: "2025-04-01", end: "2025-07-31" },
      },
      panels: [{ id: "main" }, { id: "formula" }],
      series: [fundamental("left", "LEFT"), fundamental("right", "RIGHT")],
      studies: [
        {
          id: "ratio",
          kind: "ratio",
          inputSeriesIds: ["left", "right"],
          parameters: {},
          panelId: "formula",
          axis: "left",
        },
        {
          id: "spread",
          kind: "spread",
          inputSeriesIds: ["left", "right"],
          parameters: {},
          panelId: "formula",
          axis: "left",
        },
      ],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2025-08-01T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    expect(result.series.find(({ id }) => id === "ratio")).toMatchObject({
      style: "step",
      interpolation: "step-after",
    });
    expect(result.series.find(({ id }) => id === "ratio")?.points.map((point) => ({
      date: point.date.toISOString().slice(0, 10),
      value: point.value,
    }))).toEqual([
      { date: "2025-02-20", value: 2 },
      { date: "2025-05-10", value: 2.4 },
      { date: "2025-06-10", value: 3 },
    ]);
    expect(result.series.find(({ id }) => id === "spread")?.points[0]).toMatchObject({
      date: new Date("2025-02-20T00:00:00Z"),
      value: 50,
    });
  });

  test("keeps an explicit viewport when a latest-observation cap is also set", async () => {
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({
        ...emptyFinancials(),
        annualStatements: [
          {
            date: "2023-12-31",
            availableAt: "2025-01-10",
            fieldAvailability: { totalRevenue: "2025-01-10" },
            totalRevenue: 100,
          },
          {
            date: "2024-12-31",
            availableAt: "2025-02-10",
            fieldAvailability: { totalRevenue: "2025-02-10" },
            totalRevenue: 120,
          },
        ],
      }),
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: {
        range: "ALL",
        resolution: "auto",
        dateWindow: { start: "2025-01-01", end: "2025-02-28" },
        maxPoints: 1,
      },
      panels: [{ id: "main" }],
      series: [{
        id: "revenue",
        source: {
          kind: "security",
          instrument: { symbol: "TEST" },
          fieldId: "fundamental.totalRevenue",
          period: "annual",
          timestampMode: "available-at",
        },
        style: "step",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "step-after",
      }],
      studies: [],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2025-03-01T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.series[0]?.points.map((point) => point.value)).toEqual([120]);
    expect(result.viewport).toEqual({
      start: new Date("2025-01-01T00:00:00.000Z"),
      end: new Date("2025-02-28T23:59:59.999Z"),
    });
  });

  test("keeps hidden base series available to visible studies without rendering the base", async () => {
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getPriceHistoryForResolution: async () => [
        { date: new Date("2025-01-01T16:00:00Z"), close: 10 },
        { date: new Date("2025-01-02T16:00:00Z"), close: 20 },
        { date: new Date("2025-01-03T16:00:00Z"), close: 30 },
      ],
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
        visible: false,
      }],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 2 },
        panelId: "main",
        axis: "left",
      }],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2025-01-04T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    expect(result.series.map((series) => series.id)).toEqual(["sma"]);
    expect(result.legendSeries?.map((series) => series.id)).toEqual(["price", "sma"]);
    expect(result.series[0]?.points.map((point) => point.value)).toEqual([15, 25]);
    expect(result.legendSeries?.find((series) => series.id === "price")?.timeBasis)
      .toMatchObject({ kind: "market", timeZone: "America/New_York" });
    expect(result.timelineSeries?.map((series) => series.id)).toEqual(["price"]);
    expect(result.series[0]?.timeBasis)
      .toMatchObject({ kind: "market", timeZone: "America/New_York" });
  });

  test("applies a streamed quote override before recomputing transforms and studies", async () => {
    const now = Date.now();
    const source = {
      kind: "security" as const,
      instrument: { symbol: "LIVE" },
      fieldId: "market.close",
    };
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({
        ...emptyFinancials(),
        quote: {
          symbol: "LIVE",
          price: 115,
          currency: "USD",
          change: 5,
          changePercent: 4.5,
          lastUpdated: now - 500,
        },
      }),
      getPriceHistoryForResolution: async () => [
        { date: new Date(now - 2 * 86_400_000), close: 100 },
        { date: new Date(now - 86_400_000), close: 110 },
      ],
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source,
        style: "line",
        transform: "percent",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 2 },
        panelId: "main",
        axis: "left",
      }],
    };
    const quoteOverrides = new Map([[
      chartQuoteOverrideKeyForSource(source),
      {
        symbol: "LIVE",
        price: 121,
        currency: "USD",
        change: 11,
        changePercent: 10,
        lastUpdated: now,
      },
    ]]);

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date(now),
      quoteOverrides,
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    const price = result.series.find((entry) => entry.id === "price")!;
    expect(price.points).toHaveLength(3);
    expect(price.points.at(-1)?.date.getTime()).toBe(now);
    expect(price.points.at(-1)?.value).toBeCloseTo(21);
    const sma = result.series.find((entry) => entry.id === "sma")!;
    expect(sma.points).toHaveLength(2);
    expect(sma.points.at(-1)?.date.getTime()).toBe(now);
    expect(sma.points.at(-1)?.value).toBeCloseTo(15.5);
  });

  test("keeps a quote received after resolution starts inside the latest viewport", async () => {
    const now = Date.parse("2026-08-05T14:00:00Z");
    const quoteTime = now + 60_000;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({
        ...emptyFinancials(),
        quote: {
          symbol: "FRESH",
          price: 130,
          currency: "USD",
          change: 30,
          changePercent: 30,
          lastUpdated: quoteTime,
          listingExchangeName: "XNAS",
          marketState: "POST",
          postMarketPrice: 129,
          postMarketChange: -1,
          postMarketChangePercent: -0.77,
        },
      }),
      getPriceHistoryForResolution: async () => [
        { date: new Date(now - 2 * 86_400_000), open: 99, high: 102, low: 98, close: 100 },
        { date: new Date(now - 86_400_000), open: 100, high: 101, low: 99, close: 100 },
      ],
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "6M", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "FRESH", exchange: "XNAS" },
          fieldId: "market.ohlcv",
        },
        style: "candles",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 2 },
        panelId: "main",
        axis: "left",
      }],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date(now),
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    expect(result.viewport?.end.getTime()).toBe(quoteTime);
    const price = result.series.find((entry) => entry.id === "price");
    const sma = result.series.find((entry) => entry.id === "sma");
    expect(price?.points.at(-1)?.date.getTime()).toBe(quoteTime);
    expect(price?.points.at(-1)?.close).toBe(129);
    expect(price?.latestChangePercent).toBe(30);
    expect(sma?.points.at(-1)?.date.getTime()).toBe(quoteTime);
  });

  test("reuses raw source loads while live quotes recompute the chart tail", async () => {
    const now = Date.parse("2026-05-15T20:30:00Z");
    const source = {
      kind: "security" as const,
      instrument: { symbol: "LIVE" },
      fieldId: "market.close",
    };
    let financialCalls = 0;
    let historyCalls = 0;
    let fredCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => {
        financialCalls += 1;
        return emptyFinancials();
      },
      getPriceHistoryForResolution: async () => {
        historyCalls += 1;
        return [{ date: new Date(now - 86_400_000), close: 100 }];
      },
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source,
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }, {
        id: "cpi",
        source: { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
        style: "line",
        transform: "raw",
        axis: "right",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };
    const loadFredSeries = async () => {
      fredCalls += 1;
      return fredLoad({
        observations: [{ date: "2026-05-01", value: 320 }],
        info: null,
      });
    };
    const cache = new ChartResolveCache();

    await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date(now),
      loadFredSeries,
    }, cache);
    const live = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date(now + 1_000),
      loadFredSeries,
      quoteOverrides: new Map([[
        chartQuoteOverrideKeyForSource(source),
        {
          symbol: "LIVE",
          price: 105,
          currency: "USD",
          change: 5,
          changePercent: 5,
          lastUpdated: now,
        },
      ]]),
    }, cache);

    expect(financialCalls).toBe(1);
    expect(historyCalls).toBe(1);
    expect(fredCalls).toBe(1);
    expect(live.errors).toEqual([]);
    expect(live.series.find((entry) => entry.id === "price")?.points.at(-1)?.value).toBe(105);
  });

  test("derives current trailing multiples from the live quote and latest public TTM inputs", async () => {
    const quoteTime = Date.parse("2025-05-01T16:00:00Z");
    const statements = [
      {
        date: "2024-03-31",
        availableAt: "2024-05-01",
        totalRevenue: 100,
        ebitda: 20,
        freeCashFlow: 10,
        eps: 1,
        basicShares: 10,
        totalDebt: 50,
        cashAndCashEquivalents: 20,
      },
      {
        date: "2024-06-30",
        availableAt: "2024-08-01",
        totalRevenue: 110,
        ebitda: 22,
        freeCashFlow: 11,
        eps: 1.1,
        basicShares: 10,
        totalDebt: 50,
        cashAndCashEquivalents: 20,
      },
      {
        date: "2024-09-30",
        availableAt: "2024-11-01",
        totalRevenue: 120,
        ebitda: 24,
        freeCashFlow: 12,
        eps: 1.2,
        basicShares: 10,
        totalDebt: 50,
        cashAndCashEquivalents: 20,
      },
      {
        date: "2024-12-31",
        availableAt: "2025-02-15",
        totalRevenue: 130,
        ebitda: 26,
        freeCashFlow: 13,
        eps: 1.3,
        basicShares: 10,
        totalDebt: 50,
        cashAndCashEquivalents: 20,
      },
      {
        date: "2025-03-31",
        // This newer TTM window is not public at the quote timestamp.
        availableAt: "2025-05-15",
        totalRevenue: 1_000,
        ebitda: 500,
        freeCashFlow: 400,
        eps: 20,
        basicShares: 20,
        totalDebt: 100,
        cashAndCashEquivalents: 5,
      },
    ];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({
        ...emptyFinancials(),
        quarterlyStatements: statements,
        quote: {
          symbol: "LIVE",
          price: 50,
          currency: "USD",
          change: 0,
          changePercent: 0,
          lastUpdated: quoteTime - 1_000,
        },
      }),
      getPriceHistoryForResolution: async () => [
        { date: new Date("2024-04-30T16:00:00Z"), close: 40 },
        { date: new Date("2024-07-31T16:00:00Z"), close: 45 },
        { date: new Date("2024-10-31T16:00:00Z"), close: 48 },
        { date: new Date("2025-02-14T16:00:00Z"), close: 50 },
      ],
    });
    const valuationFields = [
      "trailingPE",
      "priceSales",
      "evSales",
      "evEbitda",
      "priceFcf",
    ] as const;
    const makeSeries = (metric: typeof valuationFields[number]): ChartSpec["series"][number] => ({
      id: metric,
      source: {
        kind: "security",
        instrument: { symbol: "LIVE" },
        fieldId: `valuation.${metric}`,
        period: "quarterly",
        timestampMode: "available-at",
      },
      style: "step",
      transform: "raw",
      axis: "left",
      panelId: "main",
      interpolation: "step-after",
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: valuationFields.map(makeSeries),
      studies: [],
    };
    const firstSource = spec.series[0]!.source;
    if (firstSource.kind !== "security") throw new Error("expected security source");
    const quoteOverrides = new Map([[
      chartQuoteOverrideKeyForSource(firstSource),
      {
        symbol: "LIVE",
        price: 60,
        currency: "USD",
        change: 10,
        changePercent: 20,
        lastUpdated: quoteTime,
      },
    ]]);

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date(quoteTime),
      quoteOverrides,
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    const currentValue = (id: string) => {
      const point = result.series.find((series) => series.id === id)?.points.at(-1);
      expect(point).toMatchObject({
        date: new Date(quoteTime),
        periodLabel: "Current",
        provenance: { quality: "derived" },
      });
      return point?.value;
    };
    expect(currentValue("trailingPE")).toBeCloseTo(60 / 4.6, 10);
    expect(currentValue("priceSales")).toBeCloseTo(600 / 460, 10);
    expect(currentValue("evSales")).toBeCloseTo(630 / 460, 10);
    expect(currentValue("evEbitda")).toBeCloseTo(630 / 92, 10);
    expect(currentValue("priceFcf")).toBeCloseTo(600 / 46, 10);
  });

  test("does not re-timestamp provider forward PE or PEG on quote overrides", async () => {
    const snapshotTime = Date.parse("2025-04-30T16:00:00Z");
    const overrideTime = Date.parse("2025-05-01T16:00:00Z");
    let historyCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({
        ...emptyFinancials(),
        fundamentals: { forwardPE: 15, pegRatio: 1.5 },
        quote: {
          symbol: "STATIC",
          price: 50,
          currency: "USD",
          change: 0,
          changePercent: 0,
          lastUpdated: snapshotTime,
        },
      }),
      getPriceHistoryForResolution: async () => {
        historyCalls += 1;
        return [];
      },
    });
    const makeSeries = (metric: "forwardPE" | "pegRatio"): ChartSpec["series"][number] => ({
      id: metric,
      source: {
        kind: "security",
        instrument: { symbol: "STATIC" },
        fieldId: `valuation.${metric}`,
        timestampMode: "available-at",
      },
      style: "step",
      transform: "raw",
      axis: "left",
      panelId: "main",
      interpolation: "step-after",
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [makeSeries("forwardPE"), makeSeries("pegRatio")],
      studies: [],
    };
    const firstSource = spec.series[0]!.source;
    if (firstSource.kind !== "security") throw new Error("expected security source");
    const quoteOverrides = new Map([[
      chartQuoteOverrideKeyForSource(firstSource),
      {
        symbol: "STATIC",
        price: 60,
        currency: "USD",
        change: 10,
        changePercent: 20,
        lastUpdated: overrideTime,
      },
    ]]);

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date(overrideTime),
      quoteOverrides,
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    expect(historyCalls).toBe(0);
    expect(result.series.find(({ id }) => id === "forwardPE")?.points).toEqual([
      expect.objectContaining({ date: new Date(snapshotTime), value: 15 }),
    ]);
    expect(result.series.find(({ id }) => id === "pegRatio")?.points).toEqual([
      expect.objectContaining({ date: new Date(snapshotTime), value: 1.5 }),
    ]);
  });

  test("merges streamed quotes into the active OHLC resolution bucket", async () => {
    const now = Date.now();
    const source = {
      kind: "security" as const,
      instrument: { symbol: "LIVE" },
      fieldId: "market.ohlcv",
    };
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getPriceHistoryForResolution: async () => [
        {
          date: new Date(now - 10 * 60_000),
          open: 100,
          high: 110,
          low: 99,
          close: 108,
          volume: 1_000,
        },
        {
          date: new Date(now - 4 * 60_000),
          open: 108,
          high: 120,
          low: 105,
          close: 115,
          volume: 800,
        },
      ],
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1D", resolution: "5m" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source,
        style: "candles",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    };
    const quoteOverrides = new Map([[
      chartQuoteOverrideKeyForSource(source),
      {
        symbol: "LIVE",
        price: 121,
        currency: "USD",
        change: 6,
        changePercent: 5.2,
        lastUpdated: now,
      },
    ]]);

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date(now),
      quoteOverrides,
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    const price = result.series.find((entry) => entry.id === "price")!;
    expect(price.points).toHaveLength(2);
    expect(price.points.at(-1)).toMatchObject({
      date: new Date(now - 4 * 60_000),
      value: 121,
      open: 108,
      high: 121,
      low: 105,
      close: 121,
      volume: 800,
    });
  });

  test("calculates formulas and volume from raw inputs before display transforms", async () => {
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getPriceHistoryForResolution: async (symbol) => symbol === "LEFT"
        ? [
          { date: new Date("2025-01-01T00:00:00Z"), close: 100, volume: 1_000 },
          { date: new Date("2025-01-02T00:00:00Z"), close: 120, volume: 1_200 },
        ]
        : [
          { date: new Date("2025-01-01T00:00:00Z"), close: 200, volume: 2_000 },
          { date: new Date("2025-01-02T00:00:00Z"), close: 240, volume: 2_400 },
        ],
    });
    const makeSeries = (id: string, symbol: string): ChartSpec["series"][number] => ({
      id,
      source: { kind: "security", instrument: { symbol }, fieldId: "market.ohlcv" },
      style: "line",
      transform: "percent",
      axis: "left",
      panelId: "main",
      interpolation: "none",
    });
    const spec: ChartSpec = {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }, { id: "formula" }, { id: "volume" }],
      series: [makeSeries("left", "LEFT"), makeSeries("right", "RIGHT")],
      studies: [
        {
          id: "ratio",
          kind: "ratio",
          inputSeriesIds: ["left", "right"],
          parameters: {},
          panelId: "formula",
          axis: "left",
        },
        {
          id: "volume",
          kind: "volume",
          inputSeriesIds: ["left"],
          parameters: {},
          panelId: "volume",
          axis: "left",
        },
        {
          id: "sma",
          kind: "sma",
          inputSeriesIds: ["left"],
          parameters: { period: 2 },
          panelId: "main",
          axis: "left",
        },
      ],
    };

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date("2025-01-02T00:00:00Z"),
      loadFredSeries: async () => fredLoad(),
    });

    expect(result.errors).toEqual([]);
    expect(result.series.find((series) => series.id === "ratio")?.points.map((point) => point.value))
      .toEqual([0.5, 0.5]);
    expect(result.series.find((series) => series.id === "volume")?.points.map((point) => point.value))
      .toEqual([1_000, 1_200]);
    expect(result.series.find((series) => series.id === "sma")).toMatchObject({
      transform: "percent",
      unit: "%",
    });
    expect(result.series.find((series) => series.id === "sma")?.points.map((point) => point.value))
      .toEqual([10]);
  });
});

describe("mergePriceHistoryWindows", () => {
  const legacyMerge = (
    current: TickerFinancials["priceHistory"],
    incoming: TickerFinancials["priceHistory"],
    resolution: "1h" | "1d",
  ) => {
    const byTimestamp = new Map<number, TickerFinancials["priceHistory"][number]>();
    for (const point of [...current, ...incoming]) {
      const timestamp = point.date.getTime();
      if (Number.isFinite(timestamp)) byTimestamp.set(timestamp, point);
    }
    const sorted = [...byTimestamp.values()].sort((left, right) => left.date.getTime() - right.date.getTime());
    if (resolution === "1h") return sorted;
    const plotted = new Set(current.map((point) => point.date.getTime()));
    const merged: TickerFinancials["priceHistory"] = [];
    for (const point of sorted) {
      const previous = merged.at(-1);
      if (!previous || point.date.getTime() - previous.date.getTime() >= 86_400_000 * 0.8) {
        merged.push(point);
      } else if (!plotted.has(previous.date.getTime()) && plotted.has(point.date.getTime())) {
        merged[merged.length - 1] = point;
      }
    }
    return merged;
  };

  test("linear merge matches the prior merge for overlaps, duplicates, and unsorted fallback", () => {
    const point = (date: string, close: number) => ({ date: new Date(date), close });
    const sortedCurrent = [
      point("2026-07-28T13:30:00Z", 110),
      point("2026-07-29T13:30:00Z", 115),
      point("2026-07-29T13:30:00Z", 116),
      point("2026-07-30T13:30:00Z", 120),
    ];
    const incoming = [
      point("2026-07-27T22:00:00Z", 111),
      point("2026-07-29T13:30:00Z", 999),
      point("2026-07-29T22:00:00Z", 121),
    ];

    for (const current of [sortedCurrent, [...sortedCurrent].reverse()]) {
      for (const resolution of ["1h", "1d"] as const) {
        expect(mergePriceHistoryWindows(current, incoming, resolution)).toEqual(
          legacyMerge(current, incoming, resolution),
        );
      }
    }
  });
});
