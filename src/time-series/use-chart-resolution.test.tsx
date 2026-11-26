import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { act, useState } from "react";
import { MemoryResourceStore } from "../data/memory-resource-store";
import { setSavedCopyFrameGate, setSavedCopyStore } from "../data/pane-saved-copies";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { createTestDataProvider } from "../test-support/data-provider";
import type { DataProvider } from "../types/data-provider";
import type { PricePoint, QuoteMetadata, TickerFinancials } from "../types/financials";
import {
  MarketDataCoordinator,
  setSharedMarketDataCoordinator,
} from "../market-data/coordinator";
import { createIdleEntry } from "../market-data/result-types";
import { createQuoteStoreFixture, IDLE_COORDINATOR_QUOTES } from "../test-support/quote-store";
import { connectionHealth, DESKTOP_BRIDGE_CONNECTION_ID } from "../core/connection-health";
import { CONNECTION_LOST_MESSAGE, RpcTimeoutError } from "../utils/rpc-timeout-error";
import type { ChartResolveSources } from "./resolve-context";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";
import { rememberSeedListingFacts } from "./parsed-history-cache";
import {
  useChartResolution,
  type UseChartResolutionResult,
} from "./use-chart-resolution";

type AutoViewport = NonNullable<Parameters<typeof useChartResolution>[2]["autoViewport"]>;

const tui = createOpenTuiTestHarness();
let setAutoViewport: ((viewport: AutoViewport | null) => void) | null = null;
let setRequestViewport: ((viewport: AutoViewport | null) => void) | null = null;
let setChartSpec: ((spec: ChartSpec) => void) | null = null;
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
      instrument: { symbol: "RESOLUTION-HOOK-TEST", exchange: "NASDAQ" },
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
  spec = SPEC,
}: {
  sources: ChartResolveSources;
  spec?: ChartSpec;
}) {
  const [autoViewport, setAutoViewportState] = useState<AutoViewport | null>(null);
  const [requestViewport, setRequestViewportState] = useState<AutoViewport | null>(null);
  setAutoViewport = setAutoViewportState;
  setRequestViewport = setRequestViewportState;
  latestResult = useChartResolution(spec, sources, {
    autoViewport,
    requestViewport,
    targetPointCount: 100,
    liveRefreshIntervalMs: 0,
  });
  const pointCount = (latestResult.bufferedSeries ?? latestResult.series)
    .reduce((total, series) => total + series.points.length, 0);
  return <text>{`${latestResult.loading ? "loading" : "settled"}:${pointCount}`}</text>;
}

function MutableSpecHarness({
  sources,
}: {
  sources: ChartResolveSources;
}) {
  const [spec, setSpecState] = useState(SPEC);
  setChartSpec = setSpecState;
  latestResult = useChartResolution(spec, sources, {
    liveRefreshIntervalMs: 0,
  });
  const pointCount = (latestResult.bufferedSeries ?? latestResult.series)
    .reduce((total, series) => total + series.points.length, 0);
  return <text>{`${latestResult.loading ? "loading" : "settled"}:${pointCount}`}</text>;
}

function PollingResolutionHarness({ sources }: { sources: ChartResolveSources }) {
  latestResult = useChartResolution(SPEC, sources, {
    liveStreaming: false,
    quotePollingIntervalMs: 30,
  });
  return <text>{latestResult.loading ? "loading" : "settled"}</text>;
}

async function flushEffects(iterations = 1): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await act(async () => {
      await Promise.resolve();
      await tui.setup().renderOnce();
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

afterEach(() => {
  setAutoViewport = null;
  setRequestViewport = null;
  setChartSpec = null;
  latestResult = null;
  setSharedMarketDataCoordinator(null);
});

describe("useChartResolution", () => {
  test.each(["refresh", "live"])("an all-withheld %s replaces the plot and its saved copy", async (mode) => {
    const previous = setSavedCopyStore(new MemoryResourceStore());
    const drawn = Promise.withResolvers<void>();
    const reopened = Promise.withResolvers<void>();
    const reopenedAgain = Promise.withResolvers<void>();
    const listings = ["A", "B"].map((suffix) => ({ symbol: `WITHHELD-${mode.toUpperCase()}-${suffix}`, exchange: "NASDAQ" }));
    const spec: ChartSpec = {
      ...SPEC, viewport: { range: "1Y", resolution: "1d" },
      series: listings.map((instrument) => ({ ...SPEC.series[0]!, id: instrument.symbol, style: "line", transform: "percent",
        source: { kind: "security", instrument, fieldId: "market.close" } })),
    };
    const broken = [{ ...INITIAL_HISTORY[0]!, open: 10, low: 10 }, INITIAL_HISTORY[1]!];
    const firstActions = Promise.withResolvers<void>();
    let actionReads = 0;
    let corroborated = false;
    let failActions = false;
    const quotes = createQuoteStoreFixture();
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => mode === "live" || corroborated ? broken : INITIAL_HISTORY,
      getCorporateActions: async (symbol) => {
        actionReads += 1;
        if (failActions) throw new Error("split history temporarily unavailable");
        if (mode === "live" && !corroborated) await firstActions.promise;
        return { symbol, dividends: [], earnings: [], splits: corroborated ? [{ date: "2025-01-02", fromFactor: 10, toFactor: 1, ratio: 0.1 }] : [] };
      },
    });
    const sources = sourcesFor(provider);
    for (const listing of listings) rememberSeedListingFacts(listing, { quoteMetadata: null });
    setSharedMarketDataCoordinator({
      ...IDLE_COORDINATOR_QUOTES, ...quotes,
      subscribe: () => () => {}, getVersion: () => 1, getKeysVersion: () => 1,
      getChartEntry: () => ({ ...createIdleEntry<PricePoint[]>(), phase: "ready",
        data: broken, lastGoodData: broken, source: "test", fetchedAt: Date.now() }),
    } as never);
    const requestViewport = { start: new Date("2025-01-02"), end: new Date("2025-01-04") };
    const pointCount = () => (latestResult?.bufferedSeries ?? latestResult?.series)
      ?.reduce((total, entry) => total + entry.points.length, 0);
    function Plot() {
      latestResult = useChartResolution(spec, sources, { savedCopyScope: "comparison:free", requestViewport });
      return <text>{`points:${pointCount()}`}</text>;
    }
    try {
      await tui.render(<Plot key="start" />);
      if (mode === "live") {
        expect(latestResult?.loading).toBe(true);
        expect(pointCount()).toBe(0);
        await waitFor(() => actionReads === listings.length);
        firstActions.resolve();
      }
      await waitFor(() => latestResult?.loading === false && pointCount() === 4);

      setSavedCopyFrameGate(() => drawn.promise);
      await tui.render(<Plot key="populated-copy" />);
      expect(pointCount()).toBe(4);
      corroborated = true;
      if (mode === "refresh") {
        drawn.resolve();
      } else {
        const listing = listings[0]!;
        await act(async () => quotes.emit(listing, { symbol: listing.symbol, currency: "USD", price: 104,
          lastUpdated: Date.now(), change: 0, changePercent: 0 }));
      }
      await waitFor(() => latestResult?.loading === false && pointCount() === 0);
      expect(latestResult?.priceComparison?.dropped?.map((entry) => entry.seriesId)).toEqual(listings.map(({ symbol }) => symbol));

      setSavedCopyFrameGate(() => reopened.promise);
      await tui.render(<Plot key="reopen" />);
      expect(latestResult?.loading).toBe(false);
      expect(pointCount()).toBe(0);
      expect(latestResult?.splitNotice).toContain("returns withheld");

      if (mode === "refresh") {
        setSystemTime(Date.now() + 31_000);
        failActions = true;
        reopened.resolve();
        await waitFor(() => latestResult?.bufferedSeries !== undefined);
        const refreshedPoints = pointCount();
        const refreshedNotice = latestResult?.splitNotice;

        setSavedCopyFrameGate(() => reopenedAgain.promise);
        await tui.render(<Plot key="reopen-after-failure" />);
        expect([refreshedPoints, pointCount()]).toEqual([0, 0]);
        expect(refreshedNotice).toContain("split history unavailable");
        expect(latestResult?.splitNotice).toBe(refreshedNotice);
      }
    } finally {
      await tui.destroy();
      firstActions.resolve();
      drawn.resolve();
      reopened.resolve();
      reopenedAgain.resolve();
      setSystemTime();
      setSavedCopyFrameGate(null);
      setSavedCopyStore(previous);
    }
  });

  test("a plot saved with ticker metadata opens before refresh using the same resolved listing", async () => {
    const previous = setSavedCopyStore(new MemoryResourceStore());
    const drawn = Promise.withResolvers<void>();
    const history = Promise.withResolvers<PricePoint[]>();
    const listing = { symbol: "SAVED-CHART-TEST", exchange: "NASDAQ" };
    let filled = false;
    let refreshes = 0;
    const sources = sourcesFor(createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => {
        if (!filled) return INITIAL_HISTORY;
        refreshes += 1;
        return history.promise;
      },
    }));
    function Plot({ instrument, scope = "account:free", range = "1Y" }: {
      instrument: typeof listing & { instrument?: null };
      scope?: string;
      range?: "1Y" | "5Y";
    }) {
      const spec: ChartSpec = { ...SPEC, viewport: { ...SPEC.viewport, range }, series: [{ ...SPEC.series[0]!,
        source: { kind: "security", instrument, fieldId: "market.ohlcv" },
      }] };
      const result = useChartResolution(spec, sources, { savedCopyScope: scope, liveRefreshIntervalMs: 0 });
      return <text>{result.loading ? "loading" : `points:${result.series[0]?.points.length ?? 0}`}</text>;
    }
    try {
      await tui.render(<Plot instrument={{ ...listing, instrument: null }} />);
      await waitFor(() => tui.frame().includes("points:2"));
      filled = true;
      setSavedCopyFrameGate(() => drawn.promise);
      await tui.render(<Plot instrument={listing} />);
      await flushEffects();
      expect(tui.frame()).toContain("points:2");
      expect(refreshes).toBe(0);
      for (const render of [
        <Plot instrument={{ ...listing, exchange: "NYSE" }} />,
        <Plot instrument={listing} scope="other-account:free" />,
        <Plot instrument={listing} range="5Y" />,
      ]) {
        await tui.render(render);
        await flushEffects();
        expect(tui.frame()).toContain("loading");
      }
    } finally {
      await tui.destroy();
      drawn.resolve();
      history.resolve(INITIAL_HISTORY);
      setSavedCopyFrameGate(null);
      setSavedCopyStore(previous);
    }
  });

  test("with streaming off, polls quotes into the chart without reloading its history", async () => {
    let historyCalls = 0;
    let quoteCalls = 0;
    let subscribeCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => {
        historyCalls += 1;
        return INITIAL_HISTORY;
      },
      getQuote: async () => {
        quoteCalls += 1;
        return {
          symbol: "RESOLUTION-HOOK-TEST", price: 104 + quoteCalls, currency: "USD", change: 0, changePercent: 0,
          lastUpdated: Date.parse("2025-01-03T20:00:00.000Z") + quoteCalls,
        };
      },
      subscribeQuotes: () => {
        subscribeCalls += 1;
        return () => {};
      },
    });
    setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
    await tui.render(<PollingResolutionHarness sources={sourcesFor(provider)} />, {
      width: 24,
      height: 1,
    });

    await waitFor(() => quoteCalls >= 3 && latestResult?.loading === false);
    expect(subscribeCalls).toBe(0);
    expect(historyCalls).toBe(1);
    expect(latestResult?.series[0]?.points).toHaveLength(2);
  });

  test("streams shared quotes into the forming bar and opens the next bar at its boundary", async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const history: PricePoint[] = [
      { date: new Date(minute - 180_000), open: 100, high: 101, low: 99, close: 100, volume: 10 },
      { date: new Date(minute - 120_000), open: 100, high: 100.5, low: 99.5, close: 100, volume: 5 },
    ];
    let emit: Parameters<NonNullable<DataProvider["subscribeQuotes"]>>[1] | null = null;
    let target: Parameters<NonNullable<DataProvider["subscribeQuotes"]>>[0][number] | null = null;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => history,
      subscribeQuotes: (targets, onQuote) => {
        target = targets[0] ?? null;
        emit = onQuote;
        return () => {};
      },
    });
    setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
    const spec: ChartSpec = { ...SPEC, viewport: { range: "1D", resolution: "1m" }, series: [{ ...SPEC.series[0]!,
      source: { kind: "security", instrument: { symbol: "LIVE-BARS", exchange: "CCC" }, fieldId: "market.ohlcv" } }] };
    const sources: ChartResolveSources = { dataProvider: provider, loadFredSeries: async () => { throw new Error("unused"); } };
    await tui.render(<ResolutionHarness sources={sources} spec={spec} />, { width: 24, height: 1 });
    const bars = () => (latestResult?.bufferedSeries ?? []).find((entry) => entry.id === "price")?.points ?? [];
    const settle = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          await tui.setup().renderOnce();
        });
      }
      expect(predicate()).toBe(true);
    };
    await settle(() => bars().length === 2 && emit !== null);

    const quote = (offset: number, price: number) => ({
      symbol: "LIVE-BARS", price, currency: "USD", change: 0, changePercent: 0,
      lastUpdated: minute + offset, listingExchangeName: "CCC",
    });
    emit!(target!, quote(-100_000, 103));
    await settle(() => bars().at(-1)?.close === 103);
    emit!(target!, quote(-90_000, 98));
    await settle(() => bars().at(-1)?.close === 98);
    expect(bars().at(-1)).toMatchObject({ open: 100, high: 103, low: 98, close: 98 });

    emit!(target!, quote(-30_000, 99));
    await settle(() => bars().length === 3);
    expect(bars().at(-2)).toMatchObject({ high: 103, low: 98, close: 98 });
    expect(bars().at(-1)).toMatchObject({ date: new Date(minute - 60_000), open: 99, high: 99, low: 99, close: 99 });
  });

  test("keeps renderable data settled through empty adaptive and live refreshes", async () => {
    const adaptiveHistory = Promise.withResolvers<PricePoint[]>();
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
    setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
    const sources = sourcesFor(provider);
    await tui.render(<ResolutionHarness sources={sources} />, {
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
      await tui.setup().renderOnce();
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
        symbol: "RESOLUTION-HOOK-TEST",
        price: 105,
        currency: "USD",
        change: 1,
        changePercent: 0.96,
        lastUpdated: Date.parse("2025-01-03T20:00:00.000Z"),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await tui.setup().renderOnce();
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
    setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
    const sources = sourcesFor(provider);
    await tui.render(<ResolutionHarness sources={sources} />, {
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
      await tui.setup().renderOnce();
    });
    await waitFor(() => detailedCalls === 1);
    await flushEffects(3);

    expect(latestResult?.series).toBe(lastGoodSeries);
    expect(latestResult?.bufferedSeries).toBe(lastGoodBufferedSeries);

    await act(async () => {
      quoteHandler!(quoteTarget!, {
        symbol: "RESOLUTION-HOOK-TEST",
        price: 105,
        currency: "USD",
        change: 1,
        changePercent: 0.96,
        lastUpdated: Date.parse("2025-01-03T20:00:00.000Z"),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await tui.setup().renderOnce();
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
    await tui.render(<ResolutionHarness sources={sources} />, {
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
      await tui.setup().renderOnce();
    });
    await flushEffects(3);

    expect(latestResult?.loading).toBe(false);
    expect(latestResult?.series).toBe(lastGoodSeries);
    expect(latestResult?.bufferedSeries).toBe(lastGoodBufferedSeries);
    expect(latestResult?.errors).toEqual([]);
  });

  // A desktop chart whose request found the app's bridge down kept the failure until it was reopened.
  test("a failed chart loads again once the desktop bridge answers after an outage", async () => {
    let answering = false;
    let asked = 0;
    const history = async () => {
      asked += 1;
      if (answering) return INITIAL_HISTORY;
      throw new RpcTimeoutError(CONNECTION_LOST_MESSAGE, { elapsedMs: 5_000, limitMs: 5_000, report: "no way through" });
    };
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: history,
      getPriceHistory: history,
    });
    await tui.render(<ResolutionHarness sources={sourcesFor(provider)} />, { width: 24, height: 1 });
    await waitFor(() => latestResult?.loading === false && asked > 0);
    expect(latestResult?.errors.join(" ")).toContain(CONNECTION_LOST_MESSAGE);

    answering = true;
    await act(async () => { connectionHealth.reportRecovery(DESKTOP_BRIDGE_CONNECTION_ID); });
    await waitFor(() => latestResult?.loading === false && latestResult.series[0]?.points.length === 2);
    expect(latestResult?.errors).toEqual([]);

    // A chart that loaded is left alone by the next recovery.
    const settledAsks = asked;
    await act(async () => { connectionHealth.reportRecovery(DESKTOP_BRIDGE_CONNECTION_ID); });
    await flushEffects(2);
    expect(asked).toBe(settledAsks);
  });

  test("keeps initial and explicit reloads blocking", async () => {
    const initialHistory = Promise.withResolvers<PricePoint[]>();
    const reloadHistory = Promise.withResolvers<PricePoint[]>();
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
    // This case needs a cold identity, independent of the earlier cache tests.
    const coldSpec: ChartSpec = { ...SPEC, series: SPEC.series.map(entry => ({ ...entry,
      source: { kind: "security", instrument: { symbol: "RESOLUTION-COLD-RELOAD", exchange: "NASDAQ" }, fieldId: "market.ohlcv" },
    })) };
    await tui.render(<ResolutionHarness sources={sources} spec={coldSpec} />, {
      width: 24,
      height: 1,
    });

    await waitFor(() => historyCalls === 1);
    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.series).toEqual([]);

    await act(async () => {
      initialHistory.resolve(INITIAL_HISTORY);
      await tui.setup().renderOnce();
    });
    await waitFor(() => latestResult?.loading === false && latestResult.series[0]?.points.length === 2);
    await act(async () => {
      latestResult!.reload();
      await tui.setup().renderOnce();
    });
    await waitFor(() => historyCalls === 2);

    expect(latestResult?.loading).toBe(true);

    await act(async () => {
      reloadHistory.resolve([]);
      await tui.setup().renderOnce();
    });
    await waitFor(() => (
      latestResult?.loading === false
      && latestResult.series.every((series) => series.points.length === 0)
    ));

    expect(latestResult?.series.every((series) => series.points.length === 0)).toBe(true);
    expect(latestResult?.errors).toEqual([]);
  });

  test("paints coordinator-cached candles on the first frame", async () => {
    rememberSeedListingFacts({ symbol: "RESOLUTION-HOOK-TEST", exchange: "NASDAQ" }, { quoteMetadata: null });
    const history = Promise.withResolvers<PricePoint[]>();
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => history.promise,
      getPriceHistory: async () => [],
    });
    setSharedMarketDataCoordinator({
      ...IDLE_COORDINATOR_QUOTES,
      subscribe: () => () => {},
      getVersion: () => 1,
      getKeysVersion: () => 1,
      getChartEntry: () => ({
        ...createIdleEntry<PricePoint[]>(),
        phase: "ready",
        data: INITIAL_HISTORY,
        lastGoodData: INITIAL_HISTORY,
        source: "test",
        fetchedAt: Date.now(),
      }),
    } as never);

    await tui.render(<ResolutionHarness sources={sourcesFor(provider)} spec={{
      ...SPEC,
      viewport: { range: "5Y", resolution: "auto" },
    }} />, {
      width: 24,
      height: 1,
    });

    expect(latestResult?.series[0]?.points.length).toBe(2);
    expect(latestResult?.loading).toBe(true);

    await act(async () => {
      history.resolve(INITIAL_HISTORY);
      await tui.setup().renderOnce();
    });
    await waitFor(() => latestResult?.loading === false);
  });

  test.each(["USD", null])("cached bars wait for listing units (%s), then a warm open paints the settled units immediately", async (currency) => {
    const instrument = { symbol: `SEED-UNIT-BOUNDARY-${currency ?? "UNKNOWN"}`, exchange: "NASDAQ" };
    const spec: ChartSpec = { ...SPEC, series: [{ ...SPEC.series[0]!, source: {
      kind: "security", instrument, fieldId: "market.ohlcv",
    } }] };
    const history = Promise.withResolvers<PricePoint[]>();
    const metadata = Promise.withResolvers<QuoteMetadata | null>();
    let metadataCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => history.promise,
      getQuoteMetadata: async () => { metadataCalls += 1; return metadata.promise; },
    });
    setSharedMarketDataCoordinator({
      ...IDLE_COORDINATOR_QUOTES,
      subscribe: () => () => {}, getVersion: () => 1, getKeysVersion: () => 1,
      getChartEntry: () => ({ ...createIdleEntry<PricePoint[]>(), phase: "ready",
        data: INITIAL_HISTORY, lastGoodData: INITIAL_HISTORY, source: "test", fetchedAt: Date.now() }),
    } as never);

    await tui.render(<ResolutionHarness sources={sourcesFor(provider)} spec={spec} />, { width: 24, height: 1 });
    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.series).toEqual([]);
    history.resolve(INITIAL_HISTORY);
    await waitFor(() => metadataCalls === 1);
    expect(latestResult?.series).toEqual([]);
    const facts: QuoteMetadata | null = currency ? { symbol: instrument.symbol, listingExchangeName: instrument.exchange,
      currency, instrumentType: "EQUITY" } : null;
    metadata.resolve(facts);
    await waitFor(() => latestResult?.loading === false);
    expect(latestResult?.series[0]?.unit).toBe(currency ? "USD/share" : "currency");

    const warmHistory = Promise.withResolvers<PricePoint[]>();
    const warmProvider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => warmHistory.promise,
      getQuoteMetadata: async () => facts,
    });
    await tui.render(<ResolutionHarness key="warm" sources={sourcesFor(warmProvider)} spec={spec} />, { width: 24, height: 1 });
    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.series[0]?.points).toHaveLength(2);
    expect(latestResult?.series[0]?.unit).toBe(currency ? "USD/share" : "currency");
    warmHistory.resolve(INITIAL_HISTORY);
    await waitFor(() => latestResult?.loading === false);
  });

  test("a settled history failure is not replaced by an indefinitely loading cached seed", async () => {
    rememberSeedListingFacts({ symbol: "RESOLUTION-HOOK-TEST", exchange: "NASDAQ" }, { quoteMetadata: null });
    const history = Promise.withResolvers<PricePoint[]>();
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => history.promise,
      getPriceHistory: async () => { throw new Error("Selected history unavailable"); },
    });
    setSharedMarketDataCoordinator({
      ...IDLE_COORDINATOR_QUOTES,
      subscribe: () => () => {}, getVersion: () => 1,
      getChartEntry: () => ({ ...createIdleEntry<PricePoint[]>(), phase: "ready",
        data: INITIAL_HISTORY, lastGoodData: INITIAL_HISTORY, source: "test", fetchedAt: Date.now() }),
    } as never);
    await tui.render(<ResolutionHarness sources={sourcesFor(provider)} />, { width: 24, height: 1 });
    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.series[0]?.points.length).toBe(2);
    history.reject(new Error("Selected history unavailable"));
    await waitFor(() => latestResult?.loading === false);
    expect(latestResult?.errors.join(" ")).toContain("Selected history unavailable");
    await flushEffects(3);
    expect(latestResult?.loading).toBe(false);
  });

  test("identical hydrated specs preserve one pending resolution during quote-driven renders", async () => {
    const history = Promise.withResolvers<PricePoint[]>();
    let historyCalls = 0;
    let resolvedInputs = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => { historyCalls += 1; return history.promise; },
      getPriceHistory: async () => [],
    });
    const sources = { ...sourcesFor(provider), onSecurityData: () => { resolvedInputs += 1; } };
    await tui.render(<MutableSpecHarness sources={sources} />, { width: 24, height: 1 });
    await waitFor(() => historyCalls === 1);
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { setChartSpec?.(JSON.parse(JSON.stringify(SPEC))); });
      await flushEffects(2);
    }
    history.resolve(INITIAL_HISTORY);
    await waitFor(() => latestResult?.loading === false);
    expect(historyCalls).toBe(1);
    expect(resolvedInputs).toBe(1);
    expect(latestResult?.series[0]?.points).toHaveLength(2);
  });

  test("changing a security cannot retain its predecessor's chart after a failed request", async () => {
    const other = Promise.withResolvers<PricePoint[]>();
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async (symbol) => symbol === "OTHER" ? other.promise : INITIAL_HISTORY,
      getPriceHistory: async () => { throw new Error("OTHER unavailable"); },
    });
    await tui.render(<MutableSpecHarness sources={sourcesFor(provider)} />, { width: 24, height: 1 });
    await waitFor(() => latestResult?.loading === false && latestResult.series[0]?.points.length === 2);
    await act(async () => {
      setChartSpec?.({ ...SPEC, series: [{ ...SPEC.series[0]!, source: {
        kind: "security", instrument: { symbol: "OTHER", exchange: "NASDAQ" }, fieldId: "market.ohlcv",
      } }] });
      await tui.setup().renderOnce();
    });
    expect(latestResult?.series.flatMap((entry) => entry.points)).toEqual([]);
    expect(latestResult?.loading).toBe(true);
    other.reject(new Error("OTHER unavailable"));
    await waitFor(() => latestResult?.loading === false);
    expect(latestResult?.series.flatMap((entry) => entry.points)).toEqual([]);
    expect(latestResult?.errors.join(" ")).toContain("OTHER unavailable");
  });

  test("reuses cached history when the spec object identity changes", async () => {
    const initialHistory = Promise.withResolvers<PricePoint[]>();
    let historyCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => EMPTY_FINANCIALS,
      getPriceHistoryForResolution: async () => {
        historyCalls += 1;
        return historyCalls === 1 ? initialHistory.promise : INITIAL_HISTORY;
      },
      getPriceHistory: async () => [],
    });
    await tui.render(<MutableSpecHarness sources={sourcesFor(provider)} />, {
      width: 24,
      height: 1,
    });

    await waitFor(() => historyCalls === 1);
    await act(async () => {
      initialHistory.resolve(INITIAL_HISTORY);
      await tui.setup().renderOnce();
    });
    await waitFor(() => latestResult?.loading === false && latestResult.series[0]?.points.length === 2);

    await act(async () => {
      setChartSpec?.({
        ...SPEC,
        series: [{
          ...SPEC.series[0]!,
          style: "line",
        }],
      });
      await tui.setup().renderOnce();
    });
    await flushEffects(3);

    expect(historyCalls).toBe(1);
    expect(latestResult?.loading).toBe(false);
    expect(latestResult?.series[0]?.points.length).toBe(2);
    expect(latestResult?.series[0]?.style).toBe("line");
  });
});
