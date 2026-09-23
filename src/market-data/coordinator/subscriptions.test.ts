import { describe, expect, jest, test } from "bun:test";
import { MarketDataCoordinator } from "./index";
import { buildQuoteKey } from "../selectors";
import { createManualFrameDriver, DataFrameScheduler } from "../frame-scheduler";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";
import type { DataProvider, QuoteSubscriptionTarget } from "../../types/data-provider";
import {
  QUOTE_SUBSCRIPTION_PRIORITY_UPDATE_DELAY_MS,
  QUOTE_SUBSCRIPTION_REMOVE_GRACE_MS,
  type QuoteSubscriptionRequest,
} from "./quotes";

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

const flushCoordinatorNotify = flushCoordinator;

/** A coordinator on a manual 100 ms frame clock, so frame tiers can be stepped exactly. */
function createFramedCoordinator() {
  const clock = createManualFrameDriver(100);
  const { provider, emitQuote } = createProvider();
  const coordinator = new MarketDataCoordinator(provider, { frames: new DataFrameScheduler(clock.driver) });
  return { clock, coordinator, emitQuote };
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
    jest.useFakeTimers();
    try {
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
      const unsubscribePortfolio = coordinator.subscribeQuotes([{
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
      expect(subscriptions).toHaveLength(1);

      jest.advanceTimersByTime(QUOTE_SUBSCRIPTION_PRIORITY_UPDATE_DELAY_MS);
      expect(subscriptions).toHaveLength(2);
      expect(disposals).toBe(1);
      expect(subscriptions[1]?.[0]).toMatchObject({
        surface: "portfolio",
        visible: false,
        selected: false,
        weight: 10,
      });

      unsubscribePortfolio();
      jest.runAllTimers();
    } finally {
      jest.useRealTimers();
    }
  });

  test("coalesces priority updates and overlaps the upstream replacement", () => {
    jest.useFakeTimers();
    try {
      const events: string[] = [];
      const subscriptions: QuoteSubscriptionTarget[][] = [];
      const provider = createTestDataProvider({
        id: "test-provider",
        subscribeQuotes: (targets) => {
          const subscriptionId = subscriptions.length + 1;
          subscriptions.push(targets);
          events.push(`subscribe:${subscriptionId}`);
          return () => events.push(`dispose:${subscriptionId}`);
        },
      });
      const coordinator = new MarketDataCoordinator(provider);
      const instruments = ["AAPL", "MSFT", "NVDA"].map((symbol) => ({
        symbol,
        exchange: "NASDAQ",
      }));
      const requests = (
        selectedSymbol: string,
        selectedSurface: "portfolio" | "detail" = "portfolio",
      ): QuoteSubscriptionRequest[] => instruments.map((instrument) => ({
        instrument,
        priority: {
          surface: instrument.symbol === selectedSymbol ? selectedSurface : "portfolio",
          visible: instrument.symbol === selectedSymbol,
          selected: instrument.symbol === selectedSymbol,
          weight: instrument.symbol === selectedSymbol ? 100 : 10,
        },
      }));

      const subscription = coordinator.subscribeQuotes(requests("AAPL"));
      subscription.update(requests("MSFT"));
      subscription.update(requests("NVDA", "detail"));

      jest.advanceTimersByTime(QUOTE_SUBSCRIPTION_PRIORITY_UPDATE_DELAY_MS - 1);
      expect(subscriptions).toHaveLength(1);
      expect(events).toEqual(["subscribe:1"]);

      jest.advanceTimersByTime(1);
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[1]?.find((target) => target.symbol === "NVDA")).toMatchObject({
        surface: "detail",
        visible: true,
        selected: true,
        weight: 100,
      });
      expect(events).toEqual(["subscribe:1", "subscribe:2", "dispose:1"]);

      subscription();
      jest.runAllTimers();
    } finally {
      jest.useRealTimers();
    }
  });

  test("applies membership and routing changes immediately", () => {
    jest.useFakeTimers();
    try {
      const subscriptions: QuoteSubscriptionTarget[][] = [];
      let disposals = 0;
      const provider = createTestDataProvider({
        id: "test-provider",
        subscribeQuotes: (targets) => {
          subscriptions.push(targets);
          return () => { disposals += 1; };
        },
      });
      const coordinator = new MarketDataCoordinator(provider);
      const aapl = {
        symbol: "AAPL",
        exchange: "NASDAQ",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
        instrument: {
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-work",
          conId: 1001,
          symbol: "AAPL",
        },
      };
      const msft = { symbol: "MSFT", exchange: "NASDAQ" };
      const subscription = coordinator.subscribeQuotes([{
        instrument: aapl,
        priority: { route: "provider", surface: "portfolio" },
      }]);

      subscription.update([
        { instrument: aapl, priority: { route: "provider", surface: "portfolio" } },
        { instrument: msft, priority: { route: "provider", surface: "portfolio" } },
      ]);
      expect(subscriptions).toHaveLength(2);
      expect(disposals).toBe(1);
      expect(subscriptions[1]?.map((target) => target.symbol).sort()).toEqual(["AAPL", "MSFT"]);

      subscription.update([
        { instrument: aapl, priority: { route: "broker", surface: "detail" } },
        { instrument: msft, priority: { route: "provider", surface: "portfolio" } },
      ]);
      expect(subscriptions).toHaveLength(3);
      expect(disposals).toBe(2);
      expect(subscriptions[2]?.find((target) => target.symbol === "AAPL")).toMatchObject({
        route: "broker",
        surface: "detail",
        context: {
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-work",
          instrument: { brokerId: "ibkr", conId: 1001, symbol: "AAPL" },
        },
      });

      subscription();
      jest.runAllTimers();
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps an updated handle callable and honors removal grace on dispose", () => {
    jest.useFakeTimers();
    try {
      const subscriptions: QuoteSubscriptionTarget[][] = [];
      let disposals = 0;
      const provider = createTestDataProvider({
        id: "test-provider",
        subscribeQuotes: (targets) => {
          subscriptions.push(targets);
          return () => { disposals += 1; };
        },
      });
      const coordinator = new MarketDataCoordinator(provider);
      const instrument = { symbol: "AAPL", exchange: "NASDAQ" };
      const subscription = coordinator.subscribeQuotes([{
        instrument,
        priority: { surface: "portfolio", selected: false, weight: 10 },
      }]);

      expect(typeof subscription).toBe("function");
      expect(typeof subscription.update).toBe("function");
      subscription.update([{
        instrument,
        priority: { surface: "detail", selected: true, weight: 100 },
      }]);
      jest.advanceTimersByTime(QUOTE_SUBSCRIPTION_PRIORITY_UPDATE_DELAY_MS);
      expect(subscriptions).toHaveLength(2);
      expect(disposals).toBe(1);

      subscription();
      subscription.update([{ instrument: { symbol: "MSFT", exchange: "NASDAQ" } }]);
      subscription();
      jest.advanceTimersByTime(QUOTE_SUBSCRIPTION_REMOVE_GRACE_MS - 1);
      expect(subscriptions).toHaveLength(2);
      expect(disposals).toBe(1);

      jest.advanceTimersByTime(1);
      expect(subscriptions).toHaveLength(2);
      expect(disposals).toBe(2);
    } finally {
      jest.useRealTimers();
    }
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

  test("applies visible keys every frame and off-screen keys at most once a second, latest tick winning", () => {
    const { clock, coordinator, emitQuote } = createFramedCoordinator();
    const amd = { symbol: "AMD", exchange: "NASDAQ" };
    const msft = { symbol: "MSFT", exchange: "NASDAQ" };
    coordinator.subscribeQuotes([
      { instrument: amd, priority: { visible: true } },
      { instrument: msft, priority: { visible: false, weight: 10 } },
    ]);
    const price = (instrument: typeof amd) => coordinator.getQuoteEntry(instrument).data?.price;

    emitQuote(amd, quote("AMD", 100));
    emitQuote(msft, quote("MSFT", 200));
    expect(price(amd)).toBeUndefined();
    clock.advance(0);
    // First data for a key never waits, whatever its tier.
    expect(price(amd)).toBe(100);
    expect(price(msft)).toBe(200);

    for (let tick = 1; tick <= 5; tick += 1) {
      emitQuote(amd, quote("AMD", 100 + tick));
      emitQuote(msft, quote("MSFT", 200 + tick));
      clock.advance(100);
      expect(price(amd)).toBe(100 + tick);
      expect(price(msft)).toBe(200);
    }

    clock.advance(500);
    expect(price(msft)).toBe(205);

    // A held-back tick shows on the next frame once its row scrolls into view.
    emitQuote(msft, quote("MSFT", 206));
    clock.advance(100);
    expect(price(msft)).toBe(205);
    coordinator.subscribeQuotes([{ instrument: msft, priority: { visible: true } }]);
    clock.advance(100);
    expect(price(msft)).toBe(206);
  });

  test("applies a frame's quotes and notifies their readers in one pass", () => {
    const { clock, coordinator, emitQuote } = createFramedCoordinator();
    const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
    const msft = { symbol: "MSFT", exchange: "NASDAQ" };
    const seen: Array<[number | undefined, number | undefined]> = [];
    coordinator.subscribeKeys([buildQuoteKey(aapl), buildQuoteKey(msft)], () => {
      seen.push([coordinator.getQuoteEntry(aapl).data?.price, coordinator.getQuoteEntry(msft).data?.price]);
    });
    coordinator.subscribeQuotes([{ instrument: aapl }, { instrument: msft }]);

    emitQuote(aapl, quote("AAPL", 100));
    emitQuote(msft, quote("MSFT", 200));
    emitQuote(aapl, quote("AAPL", 101));
    clock.advance(0);

    expect(seen).toEqual([[101, 200]]);
  });

  test("a repeat that only moves the arrival time does not notify readers", () => {
    const realDateNow = Date.now;
    const { clock, coordinator, emitQuote } = createFramedCoordinator();
    const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
    const firstTimestamp = 1_800_000_000_000;
    let calls = 0;
    try {
      coordinator.subscribeKeys([buildQuoteKey(aapl)], () => { calls += 1; });
      coordinator.subscribeQuotes([{ instrument: aapl }]);
      const tick = quote("AAPL", 100, { lastUpdated: firstTimestamp, change: Number.NaN, dataSource: "live", delivery: "stream" });

      Date.now = () => firstTimestamp;
      emitQuote(aapl, tick);
      clock.advance(100);
      expect(calls).toBe(1);

      Date.now = () => firstTimestamp + 1_000;
      emitQuote(aapl, { ...tick });
      clock.advance(100);
      expect(calls).toBe(1);
      expect(coordinator.getQuoteEntry(aapl).data?.receivedAt).toBe(firstTimestamp);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("applies a tick stamped slightly ahead of the local clock", async () => {
    const { provider, emitQuote } = createProvider();
    const coordinator = new MarketDataCoordinator(provider);
    const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
    coordinator.subscribeQuotes([{ instrument: aapl }]);

    emitQuote(aapl, quote("AAPL", 123, { lastUpdated: Date.now() + 300, dataSource: "live", delivery: "stream" }));
    await flushCoordinator();

    expect(coordinator.getQuoteEntry(aapl).data?.price).toBe(123);
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
      await flushCoordinatorNotify();

      Date.now = () => firstTimestamp + 10_000;
      emitQuote({ symbol: "AAPL", exchange: "NASDAQ" }, quote("AAPL", 100, { lastUpdated: firstTimestamp + 10_000 }));
      await flushCoordinatorNotify();

      expect(calls).toBe(2);
      expect(coordinator.getQuoteEntry(aapl).data?.lastUpdated).toBe(firstTimestamp + 10_000);
      expect(coordinator.getQuoteEntry(aapl).data?.receivedAt).toBe(firstTimestamp + 10_000);

      Date.now = () => firstTimestamp + 20_000;
      emitQuote({ symbol: "AAPL", exchange: "NASDAQ" }, quote("AAPL", 101, { lastUpdated: firstTimestamp + 10_000 }));
      await flushCoordinatorNotify();

      expect(calls).toBe(3);
      expect(coordinator.getQuoteEntry(aapl).data?.price).toBe(101);
      expect(coordinator.getQuoteEntry(aapl).data?.lastUpdated).toBe(firstTimestamp + 10_000);
      expect(coordinator.getQuoteEntry(aapl).data?.receivedAt).toBe(firstTimestamp + 20_000);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("advances receipt freshness for an identical live stream heartbeat", async () => {
    const realDateNow = Date.now;
    const { provider, emitQuote } = createProvider();
    const coordinator = new MarketDataCoordinator(provider);
    const option = { symbol: "AAPL260731C00110000", exchange: "OPTIONS" };
    const firstTimestamp = 1_800_000_000_000;
    let calls = 0;

    try {
      coordinator.subscribeKeys([buildQuoteKey(option)], () => { calls += 1; });
      coordinator.subscribeQuotes([{ instrument: option }]);

      Date.now = () => firstTimestamp;
      const heartbeat = quote(option.symbol, 2.5, {
        lastUpdated: firstTimestamp,
        bid: 2.4,
        ask: 2.6,
        mark: 2.5,
        dataSource: "live",
        delivery: "stream",
        stale: false,
      });
      emitQuote(option, heartbeat);
      await flushCoordinatorNotify();

      Date.now = () => firstTimestamp + 60_000;
      emitQuote(option, heartbeat);
      await flushCoordinatorNotify();

      expect(calls).toBe(2);
      expect(coordinator.getQuoteEntry(option).data).toMatchObject({
        lastUpdated: firstTimestamp,
        receivedAt: firstTimestamp + 60_000,
      });
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
