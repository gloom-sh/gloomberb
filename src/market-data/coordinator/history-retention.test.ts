import { expect, spyOn, test } from "bun:test";
import { setSavedCopyStore } from "../../data/pane-saved-copies";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { useRegularMarketSession } from "../../test-support/market-session";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { PricePoint, Quote, TickerFinancials } from "../../types/financials";
import { createManualFrameDriver, DataFrameScheduler } from "../frame-scheduler";
import { createIdleEntry } from "../result-types";
import { buildChartKey, buildQuoteKey, buildSnapshotKey } from "../selectors";
import { createBaselineChartRequest } from "./chart";
import { archiveChartEntry, archiveSnapshotEntry } from "./history-archive";
import { MarketDataCoordinator } from "./index";

useRegularMarketSession();

test("archives exact chart values and keeps the last good answer on a failed refresh", () => {
  const bars: PricePoint[] = [
    { date: new Date("2025-01-06"), close: 103.123456789, high: 104, low: undefined, volume: -0 },
    { date: new Date("2025-01-13"), close: 105, open: 103, venueVolume: { venue: "test", volume: 55 }, partial: true },
    { date: new Date("2025-01-20"), close: NaN, low: NaN },
  ];
  const entry = { ...createIdleEntry<PricePoint[]>(), phase: "ready" as const, data: bars, lastGoodData: bars, fetchedAt: 12 };
  const restored = archiveChartEntry(entry)!();
  expect(restored).toStrictEqual(entry);
  expect(restored.data).toBe(restored.lastGoodData);
  expect(restored.data![0]).not.toBe(bars[0]);
  expect(restored.data![0]!.volume).toBe(-0);
  expect(Object.hasOwn(restored.data![0]!, "low")).toBe(true);
  expect(Object.hasOwn(restored.data![0]!, "open")).toBe(false);

  const failed = { ...entry, phase: "error" as const, data: null, error: { reasonCode: "TIMEOUT", message: "Timed out" } };
  expect(archiveChartEntry(failed)!()).toStrictEqual(failed);
});

test("packs shared chart and snapshot bars once, including after restoring them", () => {
  const date = new Date("2025-01-06");
  const priceHistory = [{ date, close: 103 }];
  const timestamp = spyOn(date, "getTime");
  const chart = archiveChartEntry({ ...createIdleEntry<PricePoint[]>(), data: priceHistory })!;
  const snapshot = archiveSnapshotEntry({ ...createIdleEntry<TickerFinancials>(), data: createTestFinancials({ priceHistory }) })!;
  expect(timestamp).toHaveBeenCalledTimes(1);

  const reopenedChart = chart();
  const reopenedSnapshot = snapshot();
  const chartTimestamp = spyOn(reopenedChart.data![0]!.date, "getTime");
  const snapshotTimestamp = spyOn(reopenedSnapshot.data!.priceHistory[0]!.date, "getTime");
  expect(archiveChartEntry(reopenedChart)).not.toBeNull();
  expect(archiveSnapshotEntry(reopenedSnapshot)).not.toBeNull();
  expect(chartTimestamp).not.toHaveBeenCalled();
  expect(snapshotTimestamp).not.toHaveBeenCalled();
});

test("a quote frame uses an archived snapshot without decoding its bars", async () => {
  const savedStore = setSavedCopyStore(null);
  const clock = createManualFrameDriver(0);
  const instrument = { symbol: "NVDA", exchange: "NASDAQ" };
  const quote = createTestQuote({ symbol: instrument.symbol, listingExchangeName: instrument.exchange, dataSource: "live" });
  let streamed: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | undefined;
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    getTickerFinancials: async () => createTestFinancials({ quote, priceHistory: [{ date: new Date("2025-01-06"), close: 103 }] }),
    subscribeQuotes: (_targets, onQuote) => {
      streamed = onQuote;
      return () => {};
    },
  }), { frames: new DataFrameScheduler(clock.driver) });
  try {
    await coordinator.loadSnapshot(instrument);
    const archived = coordinator["snapshotStore"]["entries"].get(buildSnapshotKey(instrument));
    if (!archived || !("restore" in archived)) throw new Error("Expected an unwatched snapshot archive");
    spyOn(archived.decoded, "deref").mockReturnValue(undefined);
    const restore = spyOn(archived, "restore");

    const stop = coordinator.subscribeQuotes([{ instrument }]);
    streamed!(instrument, { ...quote, price: quote.price + 1, lastUpdated: quote.lastUpdated - 1 });
    clock.advance(0);
    expect(coordinator.getQuoteEntry(instrument).data).toMatchObject({ price: quote.price, receivedAt: expect.any(Number) });
    expect(restore).not.toHaveBeenCalled();
    stop();
  } finally {
    coordinator.destroy();
    setSavedCopyStore(savedStore);
  }
});

test("long ticker browsing bounds decoded histories without displacing a watched chart or refetching a recent one", async () => {
  const savedStore = setSavedCopyStore(null);
  const chartCalls = new Map<string, number>();
  const history = (step: number) => Array.from({ length: 16 }, (_, index) => ({ date: new Date(index * step), close: index + 100 }));
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    async getTickerFinancials(symbol) {
      if (symbol.startsWith("MISS")) throw new Error("No company available");
      return createTestFinancials({ quote: createTestQuote({ symbol }), profile: { sector: "Test" }, priceHistory: history(86_400_000) });
    },
    async getPriceHistoryForResolutionWithMetadata(symbol) {
      chartCalls.set(symbol, (chartCalls.get(symbol) ?? 0) + 1);
      if (symbol.startsWith("MISS")) throw new Error("No history available");
      return { resolution: "1wk", points: history(604_800_000) };
    },
  }));
  const visit = async (symbol: string) => {
    const instrument = { symbol, exchange: "NASDAQ" };
    const request = createBaselineChartRequest(instrument);
    const stop = coordinator.subscribeKeys([buildChartKey(request), buildSnapshotKey(instrument), buildQuoteKey(instrument)], () => {});
    await coordinator.loadSnapshot(instrument);
    await coordinator.loadChart(request);
    const view = coordinator.getTickerFinancialsSync(instrument);
    return { instrument, request, stop, view };
  };
  try {
    const pinned = await visit("PINNED");
    for (let pass = 0; pass < 3; pass++) {
      for (let index = 0; index < 90; index++) {
        const current = await visit(`${index % 7 === 0 ? "MISS" : "TICKER"}${index}`);
        current.stop();
      }
      const charts = coordinator["chartStore"]["entries"];
      const snapshots = coordinator["snapshotStore"]["entries"];
      expect(charts.size).toBe(65);
      expect(snapshots.size).toBe(65);
      expect([...charts.values()].filter(entry => "data" in entry && entry.lastGoodData?.length)).toHaveLength(1);
      expect([...snapshots.values()].filter(entry => "data" in entry && entry.lastGoodData?.priceHistory.length)).toHaveLength(1);
      expect(coordinator.getTickerFinancialsSync(pinned.instrument)).toBe(pinned.view);
    }
    const recent = await visit("TICKER89");
    recent.stop();
    const calls = chartCalls.get(recent.instrument.symbol);
    expect(coordinator.getTickerFinancialsSync(recent.instrument)).toEqual(recent.view);
    expect(coordinator.getSnapshotEntry(recent.instrument).data?.priceHistory).toEqual(history(86_400_000));
    expect((await coordinator.loadChart(recent.request)).data).toEqual(recent.view?.priceHistory);
    expect(chartCalls.get(recent.instrument.symbol)).toBe(calls);
    pinned.stop();
  } finally {
    coordinator.destroy();
    setSavedCopyStore(savedStore);
  }
});
