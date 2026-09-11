import { describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import type { Quote } from "../types/financials";
import { CHART_SPEC_VERSION, type ChartSeriesSpec, type ChartSpec } from "./types";
import {
  chartQuoteOverrideKeyForTarget,
  getLiveChartQuoteTargets,
  subscribeToLiveChartQuotes,
} from "./live-quotes";

function securitySeries(
  id: string,
  symbol: string,
  fieldId: string,
  visible = true,
): ChartSeriesSpec {
  return {
    id,
    source: { kind: "security", instrument: { symbol }, fieldId },
    style: "line",
    transform: "raw",
    axis: "auto",
    panelId: "main",
    interpolation: "none",
    visible,
  };
}

function specWithSeries(series: ChartSeriesSpec[]): ChartSpec {
  return {
    version: CHART_SPEC_VERSION,
    viewport: { range: "1Y", resolution: "1d" },
    panels: [{ id: "main" }],
    series,
    studies: [],
  };
}

function quote(symbol: string, price: number, lastUpdated: number): Quote {
  return {
    symbol,
    price,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for live quote refresh.");
}

describe("live chart quotes", () => {
  test("subscribes only to visible quote-sensitive instruments and deduplicates them", () => {
    const spec = specWithSeries([
      securitySeries("aapl-close", "AAPL", "market.close"),
      securitySeries("aapl-volume", "AAPL", "market.volume"),
      securitySeries("hidden", "MSFT", "market.close", false),
      securitySeries("fundamental", "GOOG", "fundamental.totalRevenue"),
      securitySeries("valuation", "TSLA", "pe"),
      securitySeries("price-sales", "SHOP", "valuation.priceSales"),
      securitySeries("forward-pe", "NVDA", "valuation.forwardPE"),
      securitySeries("peg", "META", "valuation.pegRatio"),
      {
        id: "fred",
        source: { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
        style: "line",
        transform: "raw",
        axis: "auto",
        panelId: "main",
        interpolation: "none",
      },
    ]);

    expect(getLiveChartQuoteTargets(spec).map((target) => target.symbol)).toEqual(["AAPL", "TSLA", "SHOP"]);
  });

  test("subscribes to a hidden quote series when a visible study depends on it", () => {
    const spec = specWithSeries([
      securitySeries("hidden-price", "MSFT", "market.close", false),
    ]);
    spec.studies = [{
      id: "sma",
      kind: "sma",
      inputSeriesIds: ["hidden-price"],
      parameters: { period: 20 },
      panelId: "main",
      axis: "auto",
    }];

    expect(getLiveChartQuoteTargets(spec).map((target) => target.symbol)).toEqual(["MSFT"]);
  });

  test("coalesces bursts, serializes refreshes, and stops cleanly", async () => {
    const spec = specWithSeries([securitySeries("price", "AAPL", "market.close")]);
    let handler: Parameters<NonNullable<ReturnType<typeof createTestDataProvider>["subscribeQuotes"]>>[1]
      | undefined;
    let subscribedTarget: Parameters<NonNullable<ReturnType<typeof createTestDataProvider>["subscribeQuotes"]>>[0][number]
      | undefined;
    let unsubscribeCalls = 0;
    const provider = createTestDataProvider({
      subscribeQuotes: (targets, onQuote) => {
        subscribedTarget = targets[0];
        handler = onQuote;
        return () => {
          unsubscribeCalls += 1;
        };
      },
    });
    let releaseFirst!: () => void;
    const firstRefresh = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots: Array<ReadonlyMap<string, Quote>> = [];
    const dispose = subscribeToLiveChartQuotes({
      spec,
      dataProvider: provider,
      refreshIntervalMs: 0,
      onRefresh: async (overrides) => {
        snapshots.push(overrides);
        if (snapshots.length === 1) await firstRefresh;
      },
    });
    const key = chartQuoteOverrideKeyForTarget(subscribedTarget!);

    handler!(subscribedTarget!, quote("AAPL", 100, 100));
    handler!(subscribedTarget!, quote("AAPL", 101, 101));
    await waitFor(() => snapshots.length === 1);
    expect(snapshots[0]?.get(key)?.price).toBe(101);

    handler!(subscribedTarget!, quote("AAPL", 102, 102));
    handler!(subscribedTarget!, quote("AAPL", 99, 99));
    handler!(subscribedTarget!, quote("AAPL", 103, 103));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshots).toHaveLength(1);

    releaseFirst();
    await waitFor(() => snapshots.length === 2);
    expect(snapshots[1]?.get(key)?.price).toBe(103);

    dispose();
    dispose();
    expect(unsubscribeCalls).toBe(1);
    handler!(subscribedTarget!, quote("AAPL", 104, 104));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshots).toHaveLength(2);
  });

  test("ignores receipt-only updates but refreshes changed price or security type", async () => {
    const spec = specWithSeries([securitySeries("price", "AAPL", "market.close")]);
    let handler: Parameters<NonNullable<ReturnType<typeof createTestDataProvider>["subscribeQuotes"]>>[1]
      | undefined;
    let target: Parameters<NonNullable<ReturnType<typeof createTestDataProvider>["subscribeQuotes"]>>[0][number]
      | undefined;
    const provider = createTestDataProvider({
      subscribeQuotes: (targets, onQuote) => {
        target = targets[0];
        handler = onQuote;
        return () => {};
      },
    });
    let refreshCalls = 0;
    const dispose = subscribeToLiveChartQuotes({
      spec,
      dataProvider: provider,
      refreshIntervalMs: 0,
      onRefresh: () => {
        refreshCalls += 1;
      },
    });

    handler!(target!, { ...quote("AAPL", 100, 100), receivedAt: 100 });
    await waitFor(() => refreshCalls === 1);
    handler!(target!, { ...quote("AAPL", 100, 100), receivedAt: 101 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(refreshCalls).toBe(1);

    handler!(target!, { ...quote("AAPL", 101, 100), receivedAt: 102 });
    await waitFor(() => refreshCalls === 2);
    handler!(target!, { ...quote("AAPL", 101, 100), receivedAt: 103, instrumentType: "Common Stock" });
    await waitFor(() => refreshCalls === 3);
    dispose();
  });

  test("continues after a synchronous background refresh failure", async () => {
    const spec = specWithSeries([securitySeries("price", "AAPL", "market.close")]);
    let handler: Parameters<NonNullable<ReturnType<typeof createTestDataProvider>["subscribeQuotes"]>>[1]
      | undefined;
    let target: Parameters<NonNullable<ReturnType<typeof createTestDataProvider>["subscribeQuotes"]>>[0][number]
      | undefined;
    const provider = createTestDataProvider({
      subscribeQuotes: (targets, onQuote) => {
        target = targets[0];
        handler = onQuote;
        return () => {};
      },
    });
    let refreshCalls = 0;
    const dispose = subscribeToLiveChartQuotes({
      spec,
      dataProvider: provider,
      refreshIntervalMs: 0,
      onRefresh: () => {
        refreshCalls += 1;
        if (refreshCalls === 1) throw new Error("temporary failure");
      },
    });

    handler!(target!, quote("AAPL", 100, 100));
    await waitFor(() => refreshCalls === 1);
    handler!(target!, quote("AAPL", 101, 101));
    await waitFor(() => refreshCalls === 2);

    dispose();
  });
});
