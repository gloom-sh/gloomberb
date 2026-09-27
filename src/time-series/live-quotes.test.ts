import { describe, expect, test } from "bun:test";
import type { Quote } from "../types/financials";
import { CHART_SPEC_VERSION, type ChartSeriesSpec, type ChartSpec } from "./types";
import { createQuoteStoreFixture } from "../test-support/quote-store";
import {
  chartQuoteOverrideKeyForSource,
  chartQuoteOverrideKeyForTarget,
  createLiveChartRefresher,
  getLiveChartQuoteTargets,
  observeLiveChartQuotes,
} from "./live-quotes";
import { createTestQuote } from "../test-support/data-provider";

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
  return createTestQuote({ symbol, price, lastUpdated });
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

    // Forward P/E ends on the live quote over today's consensus; PEG is a provider snapshot.
    expect(getLiveChartQuoteTargets(spec).map((target) => target.symbol)).toEqual(["AAPL", "TSLA", "SHOP", "NVDA"]);
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

  test("serializes refreshes from store quotes with one latest follow-up, and stops cleanly", async () => {
    const spec = specWithSeries([securitySeries("price", "AAPL", "market.close")]);
    const store = createQuoteStoreFixture();
    const [target] = getLiveChartQuoteTargets(spec);
    const key = chartQuoteOverrideKeyForTarget(target!);
    let releaseFirst!: () => void;
    const firstRefresh = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let latest: ReadonlyMap<string, Quote> = new Map();
    const snapshots: Array<ReadonlyMap<string, Quote>> = [];
    const refresher = createLiveChartRefresher(async () => {
      snapshots.push(latest);
      if (snapshots.length === 1) await firstRefresh;
    });
    const stop = observeLiveChartQuotes({ spec, store, onChange: (overrides) => {
      latest = overrides;
      refresher.request();
    } });

    store.emit(target!, quote("AAPL", 100, 100));
    store.emit(target!, quote("AAPL", 101, 101));
    await waitFor(() => snapshots.length === 1);
    expect(snapshots[0]?.get(key)?.price).toBe(101);

    store.emit(target!, quote("AAPL", 102, 102));
    store.emit(target!, quote("AAPL", 99, 99));
    store.emit(target!, quote("AAPL", 103, 103));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshots).toHaveLength(1);

    releaseFirst();
    await waitFor(() => snapshots.length === 2);
    expect(snapshots[1]?.get(key)?.price).toBe(103);

    stop();
    stop();
    refresher.dispose();
    expect(store.listenerCount()).toBe(0);
    store.emit(target!, quote("AAPL", 104, 104));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshots).toHaveLength(2);
  });

  test("ignores receipt-only updates but reports changed price, volume or security type", () => {
    const spec = specWithSeries([securitySeries("price", "AAPL", "market.close")]);
    const store = createQuoteStoreFixture();
    const [target] = getLiveChartQuoteTargets(spec);
    const key = chartQuoteOverrideKeyForTarget(target!);
    let changes = 0;
    let latest: ReadonlyMap<string, Quote> = new Map();
    const stop = observeLiveChartQuotes({ spec, store, onChange: (overrides) => { changes += 1; latest = overrides; } });

    store.emit(target!, { ...quote("AAPL", 100, 100), receivedAt: 100 });
    expect(changes).toBe(1);
    store.emit(target!, { ...quote("AAPL", 100, 100), receivedAt: 101 });
    expect(changes).toBe(1);
    store.emit(target!, { ...quote("AAPL", 101, 100), receivedAt: 102 });
    expect(changes).toBe(2);
    store.emit(target!, { ...quote("AAPL", 101, 100), receivedAt: 103, volume: 5_000 });
    expect(changes).toBe(3);
    store.emit(target!, { ...quote("AAPL", 101, 100), receivedAt: 104, volume: 5_000, instrumentType: "Common Stock" });
    expect(changes).toBe(4);

    // Bid/ask traffic restamps an unchanged trade many times a minute. Only a
    // stamp in the next minute can open a bar at the same price.
    const restamp = (lastUpdated: number) => ({ ...quote("AAPL", 101, lastUpdated), receivedAt: lastUpdated,
      volume: 5_000, instrumentType: "Common Stock" });
    store.emit(target!, restamp(30_000));
    store.emit(target!, restamp(59_999));
    expect(changes).toBe(4);
    store.emit(target!, restamp(60_000));
    expect(changes).toBe(5);
    expect(latest.get(key)?.lastUpdated).toBe(60_000);
    store.emit(target!, restamp(61_000));
    store.emit(target!, { ...restamp(62_000), price: 101.5 });
    expect(changes).toBe(6);
    expect(latest.get(key)?.lastUpdated).toBe(62_000);
    stop();
  });

  test("keeps refreshing after a synchronous refresh failure", async () => {
    let refreshCalls = 0;
    const refresher = createLiveChartRefresher(() => {
      refreshCalls += 1;
      if (refreshCalls === 1) throw new Error("temporary failure");
    });
    refresher.request();
    await waitFor(() => refreshCalls === 1);
    refresher.request();
    await waitFor(() => refreshCalls === 2);
    refresher.dispose();
  });

  test("a quote stamped just ahead of the local clock still replaces an older one", () => {
    const spec = specWithSeries([securitySeries("price", "AAPL", "market.close")]);
    const store = createQuoteStoreFixture();
    const [target] = getLiveChartQuoteTargets(spec);
    const key = chartQuoteOverrideKeyForTarget(target!);
    let latest: ReadonlyMap<string, Quote> = new Map();
    const stop = observeLiveChartQuotes({ spec, store, onChange: (overrides) => { latest = overrides; } });
    const now = Date.now();
    store.emit(target!, quote("AAPL", 100, now - 5_000));
    store.emit(target!, quote("AAPL", 101, now + 1_000));
    expect(latest.get(key)?.price).toBe(101);
    stop();
  });

  test("live chart targets and quote overrides preserve same-local-symbol option definitions", async () => {
    const source = (strike: number) => ({ kind: "security" as const, fieldId: "price", instrument: { symbol: "ACME", exchange: "NASDAQ", brokerId: "fixture", brokerInstanceId: "feed", instrument: { brokerId: "fixture", brokerInstanceId: "feed", symbol: "ACME", localSymbol: "LEGACY", secType: "OPT", currency: "USD", right: "C" as const, strike, lastTradeDateOrContractMonth: "20261016", multiplier: "100" } } });
    const a = source(100); const b = source(110);
    const spec = { series: [{ id: "a", source: a }, { id: "b", source: b }], studies: [] } as unknown as ChartSpec;
    const targets = getLiveChartQuoteTargets(spec); expect(targets).toHaveLength(2);
    let received: ReadonlyMap<string, any> | undefined;
    const store = createQuoteStoreFixture();
    const dispose = observeLiveChartQuotes({ spec, store, onChange: overrides => { received = overrides; } });
    try {
      store.emit(targets[0]!, { symbol: "ACME", currency: "USD", price: 10, change: 0, changePercent: 0, lastUpdated: Date.now() });
      store.emit(targets[1]!, { symbol: "ACME", currency: "USD", price: 20, change: 0, changePercent: 0, lastUpdated: Date.now() });
      expect(received?.size).toBe(2);
      expect(received?.get(chartQuoteOverrideKeyForSource(a))?.price).toBe(10);
      expect(received?.get(chartQuoteOverrideKeyForSource(b))?.price).toBe(20);
      expect(chartQuoteOverrideKeyForTarget(targets[0]!)).toBe(chartQuoteOverrideKeyForSource(a));
    } finally { dispose(); }
  });
});
