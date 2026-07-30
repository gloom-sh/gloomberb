import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { createTestDataProvider } from "../test-support/data-provider";
import type { DataProvider } from "../types/data-provider";
import type { PricePoint, TickerFinancials } from "../types/financials";
import type { ChartResolveSources } from "./resolve";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";
import {
  useChartResolution,
  type UseChartResolutionResult,
} from "./use-chart-resolution";

type AutoViewport = NonNullable<Parameters<typeof useChartResolution>[2]["autoViewport"]>;

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setAutoViewport: ((viewport: AutoViewport | null) => void) | null = null;
let setRequestViewport: ((viewport: AutoViewport | null) => void) | null = null;
let latestResult: UseChartResolutionResult | null = null;

const EMPTY_FINANCIALS: TickerFinancials = {
  annualStatements: [],
  quarterlyStatements: [],
  priceHistory: [],
};

const INITIAL_HISTORY: PricePoint[] = [
  {
    date: new Date("2025-01-02T16:00:00.000Z"),
    open: 100,
    high: 103,
    low: 99,
    close: 102,
    volume: 1_000,
  },
  {
    date: new Date("2025-01-03T16:00:00.000Z"),
    open: 102,
    high: 105,
    low: 101,
    close: 104,
    volume: 1_200,
  },
];

const SPEC: ChartSpec = {
  version: CHART_SPEC_VERSION,
  viewport: { range: "1Y", resolution: "auto" },
  panels: [{ id: "main" }],
  series: [{
    id: "price",
    source: {
      kind: "security",
      instrument: { symbol: "TEST", exchange: "NASDAQ" },
      fieldId: "market.ohlcv",
    },
    style: "candles",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
  }],
  studies: [],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sourcesFor(dataProvider: DataProvider): ChartResolveSources {
  return {
    dataProvider,
    now: new Date("2025-01-10T00:00:00.000Z"),
    loadFredSeries: async () => {
      throw new Error("FRED is unused in this test.");
    },
  };
}

function ResolutionHarness({
  sources,
}: {
  sources: ChartResolveSources;
}) {
  const [autoViewport, setAutoViewportState] = useState<AutoViewport | null>(null);
  const [requestViewport, setRequestViewportState] = useState<AutoViewport | null>(null);
  setAutoViewport = setAutoViewportState;
  setRequestViewport = setRequestViewportState;
  latestResult = useChartResolution(SPEC, sources, {
    autoViewport,
    requestViewport,
    targetPointCount: 100,
    liveRefreshIntervalMs: 0,
  });
  const pointCount = (latestResult.bufferedSeries ?? latestResult.series)
    .reduce((total, series) => total + series.points.length, 0);
  return <text>{`${latestResult.loading ? "loading" : "settled"}:${pointCount}`}</text>;
}

async function flushEffects(iterations = 1): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await act(async () => {
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await flushEffects();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for chart resolution.");
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  setAutoViewport = null;
  setRequestViewport = null;
  latestResult = null;
});

describe("useChartResolution", () => {
  test("keeps renderable data settled through empty adaptive and live refreshes", async () => {
    const adaptiveHistory = deferred<PricePoint[]>();
    let detailedCalls = 0;
    let quoteHandler: Parameters<NonNullable<DataProvider["subscribeQuotes"]>>[1] | null = null;
    let quoteTarget: Parameters<NonNullable<DataProvider["subscribeQuotes"]>>[0][number] | null = null;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getChartResolutionSupport: () => [
        { resolution: "15m", maxRange: "1M" },
        { resolution: "1d", maxRange: "ALL" },
      ],
      getPriceHistoryForResolution: async (_symbol, _exchange, _range, resolution) => (
        resolution === "1d" ? INITIAL_HISTORY : []
      ),
      getDetailedPriceHistory: async () => {
        detailedCalls += 1;
        return adaptiveHistory.promise;
      },
      getPriceHistory: async () => [],
      subscribeQuotes: (targets, onQuote) => {
        quoteTarget = targets[0] ?? null;
        quoteHandler = onQuote;
        return () => {};
      },
    });
    const sources = sourcesFor(provider);
    testSetup = await testRender(<ResolutionHarness sources={sources} />, {
      width: 24,
      height: 1,
    });

    await waitFor(() => latestResult?.loading === false && latestResult.series[0]?.points.length === 2);
    const lastGoodSeries = latestResult!.series;
    const lastGoodBufferedSeries = latestResult!.bufferedSeries;

    await act(async () => {
      setAutoViewport?.({
        start: new Date("2025-01-02T00:00:00.000Z"),
        end: new Date("2025-01-04T00:00:00.000Z"),
      });
      await testSetup!.renderOnce();
    });
    await waitFor(() => detailedCalls === 1);

    expect(latestResult?.loading).toBe(false);
    expect(latestResult?.series).toBe(lastGoodSeries);
    expect(latestResult?.bufferedSeries).toBe(lastGoodBufferedSeries);

    adaptiveHistory.resolve([]);
    await flushEffects(3);

    expect(latestResult?.loading).toBe(false);
    expect(latestResult?.series).toBe(lastGoodSeries);
    expect(latestResult?.bufferedSeries).toBe(lastGoodBufferedSeries);
    expect(latestResult?.errors).toEqual([]);

    await act(async () => {
      quoteHandler!(quoteTarget!, {
        symbol: "TEST",
        price: 105,
        currency: "USD",
        change: 1,
        changePercent: 0.96,
        lastUpdated: Date.parse("2025-01-03T20:00:00.000Z"),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await testSetup!.renderOnce();
    });
    await flushEffects(3);

    expect(latestResult?.loading).toBe(false);
    expect(latestResult?.series).toBe(lastGoodSeries);
    expect(latestResult?.bufferedSeries).toBe(lastGoodBufferedSeries);
    expect(latestResult?.errors).toEqual([]);
  });

  test("keeps renderable data through an empty panned-history live refresh", async () => {
    let detailedCalls = 0;
    let fixedHistoryCalls = 0;
    let quoteHandler: Parameters<NonNullable<DataProvider["subscribeQuotes"]>>[1] | null = null;
    let quoteTarget: Parameters<NonNullable<DataProvider["subscribeQuotes"]>>[0][number] | null = null;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => {
        fixedHistoryCalls += 1;
        return fixedHistoryCalls === 1 ? INITIAL_HISTORY : [];
      },
      getDetailedPriceHistory: async () => {
        detailedCalls += 1;
        return [];
      },
      getPriceHistory: async () => [],
      subscribeQuotes: (targets, onQuote) => {
        quoteTarget = targets[0] ?? null;
        quoteHandler = onQuote;
        return () => {};
      },
    });
    const sources = sourcesFor(provider);
    testSetup = await testRender(<ResolutionHarness sources={sources} />, {
      width: 24,
      height: 1,
    });

    await waitFor(() => latestResult?.loading === false && latestResult.series[0]?.points.length === 2);
    const lastGoodSeries = latestResult!.series;
    const lastGoodBufferedSeries = latestResult!.bufferedSeries;

    await act(async () => {
      setRequestViewport?.({
        start: new Date("2024-12-20T00:00:00.000Z"),
        end: new Date("2024-12-27T00:00:00.000Z"),
      });
      await testSetup!.renderOnce();
    });
    await waitFor(() => detailedCalls === 1);
    await flushEffects(3);

    expect(latestResult?.series).toBe(lastGoodSeries);
    expect(latestResult?.bufferedSeries).toBe(lastGoodBufferedSeries);

    await act(async () => {
      quoteHandler!(quoteTarget!, {
        symbol: "TEST",
        price: 105,
        currency: "USD",
        change: 1,
        changePercent: 0.96,
        lastUpdated: Date.parse("2025-01-03T20:00:00.000Z"),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await testSetup!.renderOnce();
    });
    await flushEffects(3);

    expect(latestResult?.loading).toBe(false);
    expect(latestResult?.series).toBe(lastGoodSeries);
    expect(latestResult?.bufferedSeries).toBe(lastGoodBufferedSeries);
    expect(latestResult?.errors).toEqual([]);
  });

  test("keeps renderable data when an adaptive viewport request rejects", async () => {
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => INITIAL_HISTORY,
    });
    const sources = sourcesFor(provider);
    testSetup = await testRender(<ResolutionHarness sources={sources} />, {
      width: 24,
      height: 1,
    });

    await waitFor(() => latestResult?.loading === false && latestResult.series[0]?.points.length === 2);
    const lastGoodSeries = latestResult!.series;
    const lastGoodBufferedSeries = latestResult!.bufferedSeries;
    provider.getChartResolutionSupport = () => {
      throw new Error("adaptive history failed");
    };

    await act(async () => {
      setAutoViewport?.({
        start: new Date("2025-01-02T00:00:00.000Z"),
        end: new Date("2025-01-04T00:00:00.000Z"),
      });
      await testSetup!.renderOnce();
    });
    await flushEffects(3);

    expect(latestResult?.loading).toBe(false);
    expect(latestResult?.series).toBe(lastGoodSeries);
    expect(latestResult?.bufferedSeries).toBe(lastGoodBufferedSeries);
    expect(latestResult?.errors).toEqual([]);
  });

  test("keeps initial and explicit reloads blocking", async () => {
    const initialHistory = deferred<PricePoint[]>();
    const reloadHistory = deferred<PricePoint[]>();
    let historyCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => {
        historyCalls += 1;
        return historyCalls === 1 ? initialHistory.promise : reloadHistory.promise;
      },
      getPriceHistory: async () => [],
    });
    const sources = sourcesFor(provider);
    testSetup = await testRender(<ResolutionHarness sources={sources} />, {
      width: 24,
      height: 1,
    });

    await waitFor(() => historyCalls === 1);
    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.series).toEqual([]);

    await act(async () => {
      initialHistory.resolve(INITIAL_HISTORY);
      await testSetup!.renderOnce();
    });
    await waitFor(() => latestResult?.loading === false && latestResult.series[0]?.points.length === 2);
    await act(async () => {
      latestResult!.reload();
      await testSetup!.renderOnce();
    });
    await waitFor(() => historyCalls === 2);

    expect(latestResult?.loading).toBe(true);

    await act(async () => {
      reloadHistory.resolve([]);
      await testSetup!.renderOnce();
    });
    await waitFor(() => (
      latestResult?.loading === false
      && latestResult.series.every((series) => series.points.length === 0)
    ));

    expect(latestResult?.series.every((series) => series.points.length === 0)).toBe(true);
    expect(latestResult?.errors).toEqual([]);
  });
});
