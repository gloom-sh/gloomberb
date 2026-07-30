import { describe, expect, jest, test } from "bun:test";
import { MarketDataCoordinator } from "./index";
import { buildQuoteKey } from "../selectors";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";
import type { DataProvider, QuoteSubscriptionTarget } from "../../types/data-provider";

function createProvider(): {
  provider: DataProvider;
  emitQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void;
} {
  let onQuote: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
  const provider = createTestDataProvider({
    id: "test-provider",
    subscribeQuotes: (_targets, handler) => {
      onQuote = handler;
      return () => {};
    },
  });
  return {
    provider,
    emitQuote(target, quote) {
      if (!onQuote) throw new Error("subscription was not registered");
      onQuote(target, quote);
    },
  };
}

function quote(symbol: string, price: number, overrides: Partial<Quote> = {}): Quote {
  return {
    symbol,
    price,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

async function flushCoordinator(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MarketDataCoordinator key subscriptions", () => {
  test("subscribes active quote targets as one provider batch", () => {
    const subscriptions: QuoteSubscriptionTarget[][] = [];
    const provider = createTestDataProvider({
      id: "test-provider",
      subscribeQuotes: (targets) => {
        subscriptions.push(targets);
        return () => {};
      },
    });
    const coordinator = new MarketDataCoordinator(provider);

    coordinator.subscribeQuotes([
      {
        instrument: { symbol: "AAPL", exchange: "NASDAQ" },
        priority: { surface: "portfolio", visible: true, selected: true, weight: 100 },
      },
      { instrument: { symbol: "MSFT", exchange: "NASDAQ" } },
    ]);

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.map((target) => target.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(subscriptions[0]?.find((target) => target.symbol === "AAPL")).toMatchObject({
      surface: "portfolio",
      visible: true,
      selected: true,
      weight: 100,
    });
  });

  test("keeps the highest-priority target when duplicate surfaces subscribe", () => {
    const subscriptions: QuoteSubscriptionTarget[][] = [];
    let disposals = 0;
    const provider = createTestDataProvider({
      id: "test-provider",
      subscribeQuotes: (targets) => {
        subscriptions.push(targets);
        return () => {
          disposals += 1;
        };
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };

    const unsubscribeDetail = coordinator.subscribeQuotes([{
      instrument,
      priority: { surface: "detail", visible: true, selected: true, weight: 100 },
    }]);
    coordinator.subscribeQuotes([{
      instrument,
      priority: { surface: "portfolio", visible: false, selected: false, weight: 10 },
    }]);

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.[0]).toMatchObject({
      surface: "detail",
      visible: true,
      selected: true,
      weight: 100,
    });

    unsubscribeDetail();

    expect(subscriptions).toHaveLength(2);
    expect(disposals).toBe(1);
    expect(subscriptions[1]?.[0]).toMatchObject({
      surface: "portfolio",
      visible: false,
      selected: false,
      weight: 10,
    });
  });

  test("replaces a capped target window without retaining pending removals", () => {
    jest.useFakeTimers();
    try {
      const subscriptions: string[][] = [];
      let disposals = 0;
      const provider = createTestDataProvider({
        id: "test-provider",
        subscribeQuotes: (targets) => {
          subscriptions.push(targets.map((target) => target.symbol));
          return () => {
            disposals += 1;
          };
        },
      });
      const coordinator = new MarketDataCoordinator(provider);
      const oldTargets = Array.from({ length: 16 }, (_, index) => ({
        instrument: { symbol: `OPT${index}`, exchange: "OPTIONS" },
      }));
      const newTargets = Array.from({ length: 16 }, (_, index) => ({
        instrument: { symbol: `OPT${index + 2}`, exchange: "OPTIONS" },
      }));

      const unsubscribeOld = coordinator.subscribeQuotes(oldTargets);
      unsubscribeOld();
      const unsubscribeNew = coordinator.subscribeQuotes(newTargets);

      expect(disposals).toBe(1);
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[1]).toEqual(newTargets.map(({ instrument }) => instrument.symbol).sort());

      unsubscribeNew();
      jest.runAllTimers();
    } finally {
      jest.useRealTimers();
    }
  });

  test("notifies listeners for changed keys only", async () => {
    const { provider, emitQuote } = createProvider();
    const coordinator = new MarketDataCoordinator(provider);
    const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
    const msft = { symbol: "MSFT", exchange: "NASDAQ" };
    let aaplCalls = 0;
    let msftCalls = 0;

    coordinator.subscribeKeys([buildQuoteKey(aapl)], () => { aaplCalls += 1; });
    coordinator.subscribeKeys([buildQuoteKey(msft)], () => { msftCalls += 1; });
    coordinator.subscribeQuotes([{ instrument: aapl }, { instrument: msft }]);

    emitQuote({ symbol: "AAPL", exchange: "NASDAQ" }, quote("AAPL", 100));
    await flushCoordinator();

    expect(aaplCalls).toBe(1);
    expect(msftCalls).toBe(0);
  });

  test("dedupes listeners subscribed to multiple changed keys", async () => {
    const { provider, emitQuote } = createProvider();
    const coordinator = new MarketDataCoordinator(provider);
    const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
    const msft = { symbol: "MSFT", exchange: "NASDAQ" };
    let calls = 0;

    coordinator.subscribeKeys([buildQuoteKey(aapl), buildQuoteKey(msft)], () => { calls += 1; });
    coordinator.subscribeQuotes([{ instrument: aapl }, { instrument: msft }]);

    emitQuote({ symbol: "AAPL", exchange: "NASDAQ" }, quote("AAPL", 100));
    emitQuote({ symbol: "MSFT", exchange: "NASDAQ" }, quote("MSFT", 200));
    await flushCoordinator();

    expect(calls).toBe(1);
  });

  test("coalesces global notifications per microtask", async () => {
    const { provider, emitQuote } = createProvider();
    const coordinator = new MarketDataCoordinator(provider);
    const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
    const msft = { symbol: "MSFT", exchange: "NASDAQ" };
    let calls = 0;

    coordinator.subscribe(() => { calls += 1; });
    coordinator.subscribeQuotes([{ instrument: aapl }, { instrument: msft }]);

    emitQuote({ symbol: "AAPL", exchange: "NASDAQ" }, quote("AAPL", 100));
    emitQuote({ symbol: "MSFT", exchange: "NASDAQ" }, quote("MSFT", 200));
    await flushCoordinator();

    expect(calls).toBe(1);
    expect(coordinator.getVersion()).toBe(1);
  });

  test("applies repeated stream quotes that refresh quote freshness", async () => {
    const realDateNow = Date.now;
    const { provider, emitQuote } = createProvider();
    const coordinator = new MarketDataCoordinator(provider);
    const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
    let calls = 0;

    const firstTimestamp = 1_700_000_000_000;
    try {
      coordinator.subscribeKeys([buildQuoteKey(aapl)], () => { calls += 1; });
      coordinator.subscribeQuotes([{ instrument: aapl }]);

      Date.now = () => firstTimestamp;
      emitQuote({ symbol: "AAPL", exchange: "NASDAQ" }, quote("AAPL", 100, { lastUpdated: firstTimestamp }));
      await flushCoordinator();

      Date.now = () => firstTimestamp + 10_000;
      emitQuote({ symbol: "AAPL", exchange: "NASDAQ" }, quote("AAPL", 100, { lastUpdated: firstTimestamp + 10_000 }));
      await flushCoordinator();

      expect(calls).toBe(2);
      expect(coordinator.getQuoteEntry(aapl).data?.lastUpdated).toBe(firstTimestamp + 10_000);
      expect(coordinator.getQuoteEntry(aapl).data?.receivedAt).toBe(firstTimestamp + 10_000);

      Date.now = () => firstTimestamp + 20_000;
      emitQuote({ symbol: "AAPL", exchange: "NASDAQ" }, quote("AAPL", 101, { lastUpdated: firstTimestamp + 10_000 }));
      await flushCoordinator();

      expect(calls).toBe(3);
      expect(coordinator.getQuoteEntry(aapl).data?.price).toBe(101);
      expect(coordinator.getQuoteEntry(aapl).data?.lastUpdated).toBe(firstTimestamp + 10_000);
      expect(coordinator.getQuoteEntry(aapl).data?.receivedAt).toBe(firstTimestamp + 20_000);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("does not refresh receipt time from an explicitly stale polled quote", async () => {
    const realDateNow = Date.now;
    const { provider, emitQuote } = createProvider();
    const coordinator = new MarketDataCoordinator(provider);
    const option = { symbol: "AAPL260731C00110000", exchange: "OPTIONS" };
    const firstTimestamp = 1_800_000_000_000;
    try {
      coordinator.subscribeQuotes([{ instrument: option }]);

      Date.now = () => firstTimestamp;
      emitQuote(
        option,
        quote(option.symbol, 2.5, {
          lastUpdated: firstTimestamp,
          dataSource: "live",
          delivery: "stream",
          stale: false,
        }),
      );
      await flushCoordinator();

      expect(coordinator.getQuoteEntry(option).data).toMatchObject({
        delivery: "stream",
        stale: false,
        receivedAt: firstTimestamp,
      });

      Date.now = () => firstTimestamp + 10_000;
      emitQuote(
        option,
        quote(option.symbol, 2.5, {
          lastUpdated: firstTimestamp,
          dataSource: "live",
          delivery: "poll",
          stale: true,
        }),
      );
      await flushCoordinator();

      const entry = coordinator.getQuoteEntry(option);
      expect(entry.data).toBeNull();
      expect(entry.lastGoodData).toMatchObject({
        delivery: "stream",
        stale: false,
        receivedAt: firstTimestamp,
      });
    } finally {
      Date.now = realDateNow;
    }
  });
});
