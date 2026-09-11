import { FINANCIAL_VINTAGE_NOTICE } from "../utils/financial-statements";
import { describe, expect, test } from "bun:test";
import { chartSeriesSourceKey } from "../capabilities";
import type { FredSeriesData, FredSeriesLoadResult } from "../data/fred-series";
import { buildCustomChartPreset } from "../plugins/builtin/chart-composer/presets";
import { createTestDataProvider } from "../test-support/data-provider";
import type { TickerFinancials } from "../types/financials";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import {
  ChartResolveCache,
  mergePriceHistoryWindows,
  resolveChartSpecData,
  seedChartResolutionResult,
} from "./resolve";
import { CHART_SPEC_VERSION, type ChartSeriesSpec, type ChartSpec } from "./types";

function chartSeries(input: Pick<ChartSeriesSpec, "source"> & Partial<ChartSeriesSpec>): ChartSeriesSpec {
  return { id: "price", style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none", ...input };
}

function chartSpec(input: Pick<ChartSpec, "viewport" | "series"> & Partial<ChartSpec>): ChartSpec {
  return { version: CHART_SPEC_VERSION, panels: [{ id: "main" }], studies: [], ...input };
}

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
  test("credit stress windows disclose source coverage without clipping buffers or scaling effective yields", async () => {
    const spec = buildCustomChartPreset("FRED:BAMLC0A0CM,FRED:BAMLC0A0CMEY");
    const requests: string[] = [];
    const sources = {
      now: new Date("2026-09-11"),
      loadFredSeries: async (request: { seriesId: string; startDate?: string }) => {
        requests.push(request.startDate!);
        const yieldSeries = request.seriesId.endsWith("EY");
        return fredLoad({
          observations: [
            { date: "2023-09-12", value: yieldSeries ? 5.82 : 1.23 },
            { date: "2025-04-09", value: yieldSeries ? 5.5 : 1.21 },
            { date: "2026-09-10", value: yieldSeries ? 5.68 : 0.8 },
          ],
          info: { id: request.seriesId, title: yieldSeries ? "IG effective yield" : "IG OAS", units: "Percent",
            frequency: "Daily, Close", seasonalAdjustment: "Not Seasonally Adjusted", source: "FRED", notes: "",
            observationStart: "2023-09-12", observationEnd: "2026-09-10" },
        });
      },
    };
    const fiveYear = await resolveChartSpecData(spec, sources);
    expect(fiveYear.warnings.filter((warning) => warning.includes("FRED coverage"))).toHaveLength(2);
    expect(fiveYear.warnings.some((warning) => warning.includes("vintage dates"))).toBe(true);
    expect(fiveYear.series.map((series) => series.points.at(-1)?.value)).toEqual([0.8, 5.68]);
    expect(fiveYear.series.map((series) => series.unit)).toEqual(["%", "%"]);
    const recent = await resolveChartSpecData({ ...spec, viewport: { ...spec.viewport, range: "1Y" } }, sources);
    expect(requests.at(-1)! < "2023-09-12").toBe(true); // Calculation buffer predates the visible window.
    expect(recent.warnings.some((warning) => warning.includes("FRED coverage"))).toBe(false);
    const old = await resolveChartSpecData({ ...spec, viewport: { ...spec.viewport,
      dateWindow: { start: "2020-01-01", end: "2020-06-30" } } }, sources);
    expect(old.series.every((series) => series.points.length === 0)).toBe(true);
    expect(old.warnings.filter((warning) => warning.includes("Earlier dates are unavailable"))).toHaveLength(2);
    expect(old.viewport.start?.toISOString().slice(0, 10)).toBe("2020-01-01");
  });

  test("qualified price charts retain quote metadata without injecting the fetched snapshot into history", async () => {
    let quoteCalls = 0;
    let financialCalls = 0;
    const history = [{ date: new Date("2026-01-15"), close: 77.53, volume: 1234 }];
    const provider = createTestDataProvider({
      getQuote: async () => { quoteCalls++; return { symbol: "NESN", currency: "CHF", instrumentType: "EQUITY", price: 999, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-01-16") }; },
      getTickerFinancials: async () => { financialCalls++; return emptyFinancials(); },
      getPriceHistory: async () => history,
      getPriceHistoryForResolution: async () => history,
    });
    const spec = chartSpec({ viewport: { range: "1M", resolution: "1d" }, series: [chartSeries({ source: { kind: "security", instrument: { symbol: "NESN", exchange: "SWX" }, fieldId: "market.close" } })] });
    const cache = new ChartResolveCache();
    const sources = { dataProvider: provider, loadFredSeries: async () => fredLoad(), now: new Date("2026-01-16") };
    const result = await resolveChartSpecData(spec, sources, cache);
    expect(result.series[0]).toMatchObject({ unit: "CHF/share", unitGroup: "price:CHF", volumeUnit: "shares" });
    expect(result.series[0]?.points.map((point) => point.value)).toEqual([77.53]);
    await resolveChartSpecData(spec, sources, cache);
    expect(quoteCalls).toBe(1);
    expect(financialCalls).toBe(0);

    const unavailable = createTestDataProvider({
      // Optional metadata can also fail synchronously in a provider adapter.
      getQuote: () => { throw new Error("Quote temporarily unavailable"); },
      getPriceHistory: async () => history,
      getPriceHistoryForResolution: async () => history,
    });
    const withoutMetadata = await resolveChartSpecData(spec, { ...sources, dataProvider: unavailable });
    expect(withoutMetadata.errors).toEqual([]);
    expect(withoutMetadata.series[0]?.points.map((point) => point.value)).toEqual([77.53]);
    expect(withoutMetadata.series[0]?.unit).toBe("currency/share");
  });

  test("seeds study series so their panels survive the wait for real data", async () => {
    const date = new Date("2026-01-05T00:00:00.000Z");
    const seeded = seedChartResolutionResult(
      chartSpec({
        viewport: { range: "1M", resolution: "auto" },
        panels: [{ id: "main" }, { id: "volume" }],
        series: [chartSeries({
          source: {
            kind: "security",
            instrument: { symbol: "TEST", exchange: "NASDAQ" },
            fieldId: "market.ohlcv",
          },
          style: "candles",
        })],
        studies: [{
          id: "volume",
          kind: "volume",
          inputSeriesIds: ["price"],
          parameters: {},
          panelId: "volume",
          axis: "left",
        }],
      }),
      new Map([[
        chartQuoteOverrideKeyForSource({
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.ohlcv",
        }),
        [{ date, open: 10, high: 12, low: 9, close: 11, volume: 5_000 }],
      ]]),
    );

    const volume = seeded?.series.find((entry) => entry.panelId === "volume");
    expect(volume?.points.map((point) => point.value)).toEqual([5_000]);
    expect(seeded?.bufferedSeries?.find((entry) => entry.panelId === "volume")?.points).toHaveLength(1);
  });

  test("direct volume fields and volume studies retain established units without labeling crypto volume as shares", async () => {
    for (const [instrumentType, expectedUnit] of [["EQUITY", "shares"], ["FUTURE", "contracts"], ["CRYPTOCURRENCY", ""], [undefined, ""]] as const) {
      const history = [{ date: new Date("2026-01-15"), close: 1, volume: 1234 }];
      const financials = { ...emptyFinancials(), quote: { symbol: "TEST", currency: "USD", price: 1, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-01-15"), instrumentType }, priceHistory: history };
      const provider = createTestDataProvider({
        getQuote: async () => financials.quote,
        getTickerFinancials: async () => financials,
        getPriceHistory: async () => history,
        getPriceHistoryForResolution: async () => history,
      });
      const result = await resolveChartSpecData(chartSpec({
        viewport: { range: "1M", resolution: "1d" },
        series: [chartSeries({ id: "direct", source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.volume" } }), chartSeries({ id: "price", source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" } })],
        studies: [{ id: "volume", kind: "volume", inputSeriesIds: ["price"], parameters: {}, panelId: "main", axis: "left" }],
      }), { dataProvider: provider, loadFredSeries: async () => fredLoad(), now: new Date("2026-01-16") });
      for (const id of ["direct", "volume"]) {
        expect(result.series.find((entry) => entry.id === id)?.unit).toBe(expectedUnit);
        expect(result.series.find((entry) => entry.id === id)?.points.map((point) => point.value)).toEqual([1234]);
      }
      expect(result.warnings.some((warning) => warning.includes("Volume unit unknown"))).toBe(!expectedUnit);
    }
  });

  test("cached history honors the visible date range before the network resolves", () => {
    const source = { kind: "security" as const, instrument: { symbol: "TEST", exchange: "NASDAQ" }, fieldId: "market.close" };
    const history = ["2021-01-01", "2026-08-01", "2026-08-15", "2026-09-10"].map((day, i) => ({
      date: new Date(`${day}T00:00:00Z`), close: 100 + i, volume: 1_000 + i,
    }));
    const seeded = seedChartResolutionResult(chartSpec({
      viewport: { range: "1M", resolution: "auto" },
      series: [chartSeries({ source, transform: "percent" })],
    }), new Map([[chartQuoteOverrideKeyForSource(source), history]]));
    expect(seeded?.viewport?.start.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(seeded?.viewport?.end.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(seeded?.series[0]?.points.map((p) => p.date.toISOString().slice(0, 10))).toEqual(["2026-08-15", "2026-09-10"]);
    expect(seeded?.series[0]?.points[0]?.value).toBe(0);
    expect(seeded?.bufferedSeries?.[0]?.points).toHaveLength(4);
  });

  test("a point-limited seed exposes a viewport only for an explicit date window", () => {
    const source = { kind: "security" as const, instrument: { symbol: "TEST", exchange: "NASDAQ" }, fieldId: "market.close" };
    const history = ["2026-08-01", "2026-08-15", "2026-09-10"].map((day, index) => ({
      date: new Date(`${day}T00:00:00Z`), close: 100 + index,
    }));
    const cached = new Map([[chartQuoteOverrideKeyForSource(source), history]]);
    const spec = chartSpec({ viewport: { range: "1Y", resolution: "auto", maxPoints: 2 }, series: [chartSeries({ source })] });
    const seed = seedChartResolutionResult(spec, cached);
    expect(seed?.series[0]?.points).toHaveLength(2);
    expect(seed?.viewport).toBeUndefined();
    expect(seed?.bufferedSeries).toBeUndefined();
    const explicit = seedChartResolutionResult({ ...spec, viewport: {
      ...spec.viewport, dateWindow: { start: "2026-08-01", end: "2026-09-10" },
    } }, cached);
    expect(explicit?.viewport?.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(explicit?.viewport?.end.toISOString()).toBe("2026-09-10T23:59:59.999Z");
  });

  test("stale cached observations cannot move a current preset window into the past", () => {
    const source = { kind: "security" as const, instrument: { symbol: "TEST" }, fieldId: "market.close" };
    const cached = new Map([[chartQuoteOverrideKeyForSource(source), [{ date: new Date("2026-08-31T00:00:00Z"), close: 100 }]]]);
    const result = seedChartResolutionResult(chartSpec({ viewport: { range: "1M", resolution: "auto" },
      series: [chartSeries({ source })] }), cached, new Date("2026-09-10T18:00:00Z"));
    expect(result?.viewport).toEqual({ start: new Date("2026-08-10T18:00:00Z"), end: new Date("2026-09-10T18:00:00Z") });
  });

  test("keeps study output over the whole buffered history its base series carries", async () => {
    const history = Array.from({ length: 900 }, (_, day) => {
      const date = new Date(Date.UTC(2024, 0, 1) + day * 86_400_000);
      return date.getUTCDay() === 0 || date.getUTCDay() === 6
        ? null
        : { date, open: 100, high: 101, low: 99, close: 100 + (day % 7), volume: 1_000 + day };
    }).filter((point): point is NonNullable<typeof point> => point !== null);
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: () => [{ resolution: "1d", maxRange: "ALL" }],
      getPriceHistoryForResolution: async () => history,
      getDetailedPriceHistory: async () => history,
    });
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }, { id: "volume", label: "Volume", height: 0.24 }],
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
      })],
      studies: [{
        id: "volume",
        kind: "volume",
        inputSeriesIds: ["price"],
        parameters: {},
        panelId: "volume",
        axis: "left",
      }],
    });
    const sources = {
      dataProvider: provider,
      now: new Date("2026-06-15T00:00:00.000Z"),
      loadFredSeries: async () => fredLoad(),
    };
    const cache = new ChartResolveCache();

    await resolveChartSpecData(spec, sources, cache);
    // Panning back accumulates older bars into the buffer. The study has to
    // follow, or it empties out wherever the base series has already been.
    const panned = await resolveChartSpecData(spec, sources, cache, {
      requestViewport: {
        start: new Date("2024-02-01T00:00:00.000Z"),
        end: new Date("2024-08-01T00:00:00.000Z"),
      },
    });

    const span = (id: string) => {
      const entry = panned.bufferedSeries?.find((candidate) => candidate.id === id);
      return entry && entry.points.length > 0
        ? {
            first: entry.points[0]!.date.toISOString(),
            last: entry.points.at(-1)!.date.toISOString(),
          }
        : null;
    };
    expect(span("volume")).toEqual(span("price"));
  });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1M", resolution: "auto" },
      series: [chartSeries({
        id: "plugin-series",
        source: { kind: "capability", capabilityId: "charts.test", seriesId: "one" },
        style: "area",
        axis: "auto",
      })],
    });
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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1M", resolution: "auto" },
      series: [chartSeries({
        id: "plugin-series",
        source: { kind: "capability", capabilityId: "charts.test", seriesId: "provider/series" },
      })],
    });
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
      const spec: ChartSpec = chartSpec({
        viewport: { range: scenario.range, resolution: "auto" },
        series: scenario.periods.map((period, index) => (chartSeries({
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
          interpolation: "none" as const,
        }))),
      });

      const result = await resolveChartSpecData(spec, {
        dataProvider: provider,
        now: new Date("2025-01-08T00:00:00Z"),
        loadFredSeries: async () => fredLoad(),
      });

      expect(result.errors).toEqual([]);
      expect(new Set(requestedResolutions)).toEqual(new Set([scenario.expected]));
    }
  });

  test("skips financials and broker resolution support for ohlcv charts with an exchange", async () => {
    let financialCalls = 0;
    let resolveSupport: (() => void) | null = null;
    const supportGate = new Promise<void>((resolve) => {
      resolveSupport = resolve;
    });
    const provider = createTestDataProvider({
      getTickerFinancials: async () => {
        financialCalls += 1;
        return emptyFinancials();
      },
      getChartResolutionSupport: async () => {
        await supportGate;
        return [{ resolution: "1d" as const, maxRange: "5Y" as const }];
      },
      getPriceHistoryForResolution: async () => [
        { date: new Date("2025-01-07T16:00:00Z"), close: 100 },
      ],
    });
    const spec: ChartSpec = chartSpec({
      viewport: { range: "5Y", resolution: "auto" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.ohlcv",
        },
        style: "candles",
      })],
    });

    const result = await Promise.race([
      resolveChartSpecData(spec, {
        dataProvider: provider,
        now: new Date("2025-01-08T00:00:00Z"),
        loadFredSeries: async () => fredLoad(),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("hung waiting for broker resolution support")), 200);
      }),
    ]);

    expect(financialCalls).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.series[0]?.points).toHaveLength(1);
    resolveSupport?.();
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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1W", resolution: "5m" },
      series: [chartSeries({
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
      })],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1M", resolution: "45m" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
      })],
    });

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

  test.each([
    { selected: "1wk", maxRange: "ALL", range: "ALL", expected: "1wk" },
    { selected: "1mo", maxRange: "ALL", range: "ALL", expected: "1mo" },
    { selected: "1wk", maxRange: "5Y", range: "ALL", expected: "1mo" },
    { selected: "5m", maxRange: "1W", range: "ALL", expected: "1mo" },
    { selected: "1wk", maxRange: "5Y", range: "1Y", expected: "1wk" },
  ] as const)("honors $selected/$range only within the provider's $maxRange limit", async ({ selected, maxRange, range, expected }) => {
    const requests: string[] = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: () => [
        { resolution: selected, maxRange },
        { resolution: "1mo", maxRange: "ALL" },
      ],
      getPriceHistoryForResolution: async (_symbol, _exchange, _range, resolution) => {
        requests.push(resolution);
        return [{ date: new Date("2026-08-03"), close: resolution === "1wk" ? 35 : 33 }];
      },
    });
    const spec = chartSpec({
      viewport: { range, resolution: selected },
      series: [chartSeries({ source: {
        kind: "security", instrument: { symbol: "TEST", exchange: "LSE" }, fieldId: "market.close",
      } })],
    });
    const result = await resolveChartSpecData(spec, {
      dataProvider: provider, now: new Date("2026-09-11"), loadFredSeries: async () => fredLoad(),
    });

    expect(requests).toEqual([expected]);
    expect(result.resolution).toBe(expected);
    expect(result.series[0]?.points.at(-1)?.value).toBe(expected === "1wk" ? 35 : 33);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("Auto resolution was used instead")))
      .toBe(expected !== selected);
  });

  test.each(["ALL", "5Y"] as const)("checks explicit long date windows against the %s manual limit", async (maxRange) => {
    const requests: string[] = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: () => [
        { resolution: "1wk", maxRange },
        { resolution: "1mo", maxRange: "ALL" },
      ],
      getDetailedPriceHistory: async (_symbol, _exchange, _start, _end, resolution) => {
        requests.push(resolution);
        return [{ date: new Date("1997-07-01"), close: 10 }];
      },
    });
    const spec = chartSpec({
      viewport: { range: "ALL", resolution: "1wk", dateWindow: { start: "1997-01-01", end: "2026-09-11" } },
      series: [chartSeries({ source: {
        kind: "security", instrument: { symbol: "TEST", exchange: "LSE" }, fieldId: "market.close",
      } })],
    });
    const result = await resolveChartSpecData(spec, {
      dataProvider: provider, now: new Date("2026-09-11"), loadFredSeries: async () => fredLoad(),
    });
    expect(requests).toEqual([maxRange === "ALL" ? "1wk" : "1mo"]);
    expect(result.errors).toEqual([]);
  });

  test("requires every comparison source to support the manual ALL interval", async () => {
    const requests: string[] = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => emptyFinancials(),
      getChartResolutionSupport: (symbol) => [
        { resolution: "1wk", maxRange: symbol === "UNLIMITED" ? "ALL" : "5Y" },
        { resolution: "1mo", maxRange: "ALL" },
      ],
      getPriceHistoryForResolution: async (symbol, _exchange, _range, resolution) => {
        requests.push(`${symbol}:${resolution}`);
        return [{ date: new Date("2026-08-03"), close: 33 }];
      },
    });
    const spec = chartSpec({
      viewport: { range: "ALL", resolution: "1wk" },
      series: ["UNLIMITED", "LIMITED"].map((symbol) => chartSeries({ id: symbol, source: {
        kind: "security", instrument: { symbol, exchange: "LSE" }, fieldId: "market.close",
      } })),
    });
    const result = await resolveChartSpecData(spec, {
      dataProvider: provider, now: new Date("2026-09-11"), loadFredSeries: async () => fredLoad(),
    });
    expect(requests.sort()).toEqual(["LIMITED:1mo", "UNLIMITED:1mo"]);
    expect(result.resolution).toBe("1mo");
    expect(result.resolutionSupport).toContainEqual({ resolution: "1wk", maxRange: "5Y" });
    expect(result.warnings).toContain("1WK data is unavailable for this range. Auto resolution was used instead.");
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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1D", resolution: "5m" },
      series: [{
        id: "price",
        source,
        style: "candles",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1D", resolution: "auto" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "SNDK" },
          fieldId: "market.close",
        },
      })],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1W", resolution: "auto" },
      series: [chartSeries({
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
      })],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1W", resolution: "auto" },
      series: [chartSeries({
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
      })],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "3M", resolution: "auto" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
      })],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1h" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
      })],
    });
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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
      })],
    });
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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "3M", resolution: "1d" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
        transform: "percent",
      })],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 2 },
        panelId: "main",
        axis: "left",
      }],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }, { id: "macro", height: 0.4 }],
      series: [
        chartSeries({
          id: "aapl-price",
          source: { kind: "security", instrument: { symbol: "AAPL" }, fieldId: "market.close" },
          transform: "percent",
          axis: "auto",
        }),
        chartSeries({
          id: "msft-revenue",
          source: {
            kind: "security",
            instrument: { symbol: "MSFT" },
            fieldId: "fundamental.totalRevenue",
            period: "annual",
            timestampMode: "available-at",
          },
          style: "columns",
          axis: "auto",
          interpolation: "step-after",
        }),
        chartSeries({
          id: "cpi",
          source: { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
          style: "step",
          axis: "auto",
          panelId: "macro",
          interpolation: "step-after",
        }),
      ],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: {
        range: "1Y",
        resolution: "auto",
        dateWindow: { start: "2025-01-01", end: "2025-01-31" },
      },
      series: [chartSeries({
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
      })],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 3 },
        panelId: "main",
        axis: "left",
      }],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: {
        range: "1D",
        resolution: "auto",
        dateWindow: { start: "2025-01-01", end: "2025-01-31" },
      },
      series: [chartSeries({
        source: { kind: "security", instrument: { symbol: "TEST" }, fieldId: "market.close" },
      })],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: {
        range: "1M",
        resolution: "auto",
        dateWindow: { start: "2025-01-01", end: "2025-01-31" },
      },
      series: [chartSeries({
        id: "revenue",
        source: {
          kind: "security",
          instrument: { symbol: "TEST" },
          fieldId: "fundamental.totalRevenue",
          period: "annual",
          timestampMode: "available-at",
        },
        style: "step",
        interpolation: "step-after",
      })],
    });

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
    const fundamental = (id: string, symbol: string): ChartSpec["series"][number] => (chartSeries({
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
    }));
    const spec: ChartSpec = chartSpec({
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
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: {
        range: "ALL",
        resolution: "auto",
        dateWindow: { start: "2025-01-01", end: "2025-02-28" },
        maxPoints: 1,
      },
      series: [chartSeries({
        id: "revenue",
        source: {
          kind: "security",
          instrument: { symbol: "TEST" },
          fieldId: "fundamental.totalRevenue",
          period: "annual",
          timestampMode: "available-at",
        },
        style: "step",
        interpolation: "step-after",
      })],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "TEST", exchange: "NASDAQ" },
          fieldId: "market.close",
        },
        visible: false,
      })],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 2 },
        panelId: "main",
        axis: "left",
      }],
    });

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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1d" },
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
    });
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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "6M", resolution: "1d" },
      series: [chartSeries({
        source: {
          kind: "security",
          instrument: { symbol: "FRESH", exchange: "XNAS" },
          fieldId: "market.ohlcv",
        },
        style: "candles",
      })],
      studies: [{
        id: "sma",
        kind: "sma",
        inputSeriesIds: ["price"],
        parameters: { period: 2 },
        panelId: "main",
        axis: "left",
      }],
    });

    const result = await resolveChartSpecData(spec, {
      dataProvider: provider,
      now: new Date(now),
      quoteOverrides: new Map([[
        chartQuoteOverrideKeyForSource({
          kind: "security",
          instrument: { symbol: "FRESH", exchange: "XNAS" },
          fieldId: "market.ohlcv",
        }),
        {
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
      ]]),
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

  test.each(["line", "candles"] as const)("keeps one daily bar when a live quote updates a %s chart", async (style) => {
    const now = Date.parse("2026-09-10T18:44:00Z");
    const source = { kind: "security" as const, instrument: { symbol: "SQQQ", exchange: "NASDAQ" }, fieldId: "market.close" };
    const provider = createTestDataProvider({
      getPriceHistoryForResolution: async () => [{
        date: new Date("2026-09-10T13:30:00Z"), open: 40, high: 41, low: 39, close: 39.77, volume: 1000,
      }],
    });
    const result = await resolveChartSpecData(chartSpec({
      viewport: { range: "1M", resolution: "1d" },
      series: [{ id: "price", source, style, transform: "raw", axis: "left", panelId: "main", interpolation: "none" }],
    }), {
      dataProvider: provider,
      now: new Date(now),
      quoteOverrides: new Map([[chartQuoteOverrideKeyForSource(source), {
        symbol: "SQQQ", price: 39.75, currency: "USD", change: 0, changePercent: 0,
        lastUpdated: now, listingExchangeName: "NASDAQ", marketState: "REGULAR",
      }]]),
    });
    expect(result.errors).toEqual([]);
    expect(result.series[0]?.points).toHaveLength(1);
    expect(result.series[0]?.points[0]).toMatchObject({ value: 39.75, open: 40, high: 41, low: 39, volume: 1000 });
  });

  test("retains the known listing session when the quote omits exchange metadata", async () => {
    const now = Date.parse("2026-09-11T00:01:00Z");
    const source = { kind: "security" as const, instrument: { symbol: "SQQQ", exchange: "NASDAQ" }, fieldId: "market.close" };
    const result = await resolveChartSpecData(chartSpec({
      viewport: { range: "1M", resolution: "1d" },
      series: [{ id: "price", source, style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }],
    }), {
      dataProvider: createTestDataProvider({ getPriceHistoryForResolution: async () => [
        { date: new Date("2026-09-10T00:00:00Z"), close: 100 },
      ] }),
      now: new Date(now),
      quoteOverrides: new Map([[chartQuoteOverrideKeyForSource(source), {
        symbol: "SQQQ", price: 100, postMarketPrice: 105, currency: "USD", change: 0, changePercent: 0,
        lastUpdated: now - 60_000, marketState: "POST",
      }]]),
    });
    expect(result.errors).toEqual([]);
    expect(result.series[0]?.points).toHaveLength(1);
    expect(result.series[0]?.points[0]?.value).toBe(105);
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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      series: [{
        id: "price",
        source,
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }, chartSeries({
        id: "cpi",
        source: { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
        axis: "right",
      })],
    });
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
    const makeSeries = (metric: typeof valuationFields[number]): ChartSpec["series"][number] => (chartSeries({
      id: metric,
      source: {
        kind: "security",
        instrument: { symbol: "LIVE" },
        fieldId: `valuation.${metric}`,
        period: "quarterly",
        timestampMode: "available-at",
      },
      style: "step",
      interpolation: "step-after",
    }));
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      series: valuationFields.map(makeSeries),
    });
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
    const makeSeries = (metric: "forwardPE" | "pegRatio"): ChartSpec["series"][number] => (chartSeries({
      id: metric,
      source: {
        kind: "security",
        instrument: { symbol: "STATIC" },
        fieldId: `valuation.${metric}`,
        timestampMode: "available-at",
      },
      style: "step",
      interpolation: "step-after",
    }));
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      series: [makeSeries("forwardPE"), makeSeries("pegRatio")],
    });
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
    const spec: ChartSpec = chartSpec({
      viewport: { range: "1D", resolution: "5m" },
      series: [{
        id: "price",
        source,
        style: "candles",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
    });
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
    const makeSeries = (id: string, symbol: string): ChartSpec["series"][number] => (chartSeries({
      id,
      source: { kind: "security", instrument: { symbol }, fieldId: "market.ohlcv" },
      transform: "percent",
    }));
    const spec: ChartSpec = chartSpec({
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
    });

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

test("financial charts disclose snapshot vintages once without changing period or availability timestamps", async () => {
  const dataProvider = createTestDataProvider({ getTickerFinancials: async () => ({
    annualStatements: [{ date: "2017-06-30", totalRevenue: 96_571_000_000, netIncome: 25_489_000_000, fieldAvailability: { totalRevenue: "2018-08-03", netIncome: "2018-08-03" } }],
    quarterlyStatements: [], priceHistory: [],
  }) });
  for (const timestampMode of ["period-end", "available-at"] as const) {
    const result = await resolveChartSpecData(chartSpec({ viewport: { range: "ALL", resolution: "auto" },
      series: ["totalRevenue", "netIncome"].map((field) => chartSeries({ id: field, style: "columns",
        source: { kind: "security", instrument: { symbol: "MSFT", exchange: "NASDAQ" }, fieldId: `fundamental.${field}`, period: "annual", timestampMode },
      })),
    }), { dataProvider });
    expect(result.warnings.filter((warning) => warning === FINANCIAL_VINTAGE_NOTICE)).toHaveLength(1);
    expect(result.series[0]?.points[0]).toMatchObject({ value: 96_571_000_000, observedAt: new Date("2017-06-30T00:00:00Z"), availableAt: new Date("2018-08-03T00:00:00Z"), date: new Date(timestampMode === "period-end" ? "2017-06-30T00:00:00Z" : "2018-08-03T00:00:00Z") });
  }
});
