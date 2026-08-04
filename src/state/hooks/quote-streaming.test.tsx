import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../market-data/coordinator";
import { createTestDataProvider } from "../../test-support/data-provider";
import { useLiveQuoteEntries, useQuoteStreaming, useQuoteUpdates } from "./quote-streaming";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let bumpHarness: (() => void) | null = null;
let togglePollingPriority: (() => void) | null = null;
let updateLiveTargets: ((symbol: string) => void) | null = null;
let updateFreshnessScope: ((scope: string) => void) | null = null;
let observedSubscriptionStartedAt = 0;

function QuoteStreamingHarness() {
  const [tick, setTick] = useState(0);
  bumpHarness = () => setTick((current) => current + 1);

  useQuoteStreaming([{
    symbol: "AAPL",
    exchange: "NASDAQ",
  }]);

  return <text>{String(tick)}</text>;
}

function QuotePollingHarness() {
  useQuoteUpdates([{
    symbol: "AAPL",
    exchange: "NASDAQ",
  }], {
    liveStreaming: false,
    pollIntervalMs: 30,
  });
  return <text>polling</text>;
}

function QuotePollingPriorityHarness() {
  const [selected, setSelected] = useState(false);
  togglePollingPriority = () => setSelected((current) => !current);
  useQuoteUpdates([{
    symbol: "AAPL",
    exchange: "NASDAQ",
    selected,
    weight: selected ? 100 : 10,
  }], {
    liveStreaming: false,
    pollIntervalMs: 1_000,
  });
  return <text>{selected ? "selected" : "idle"}</text>;
}

function LiveQuoteFreshnessHarness() {
  const [symbol, setSymbol] = useState("AAPL");
  const [freshnessScopeKey, setFreshnessScopeKey] = useState("expiration-1");
  updateLiveTargets = setSymbol;
  updateFreshnessScope = setFreshnessScopeKey;
  observedSubscriptionStartedAt = useLiveQuoteEntries(
    [{ symbol, exchange: "OPTIONS" }],
    { freshnessScopeKey },
  ).subscriptionStartedAt;
  return <text>{symbol}</text>;
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  bumpHarness = null;
  togglePollingPriority = null;
  updateLiveTargets = null;
  updateFreshnessScope = null;
  observedSubscriptionStartedAt = 0;
  setSharedMarketDataCoordinator(null);
});

describe("useQuoteStreaming", () => {
  test("does not resubscribe when the component rerenders with the same targets", async () => {
    let subscribeCalls = 0;
    let unsubscribeCalls = 0;
    const coordinator = {
      subscribeQuotes: () => {
        subscribeCalls += 1;
        return () => {
          unsubscribeCalls += 1;
        };
      },
    };
    setSharedMarketDataCoordinator(coordinator as unknown as MarketDataCoordinator);

    testSetup = await testRender(<QuoteStreamingHarness />, {
      width: 20,
      height: 1,
    });

    await act(async () => {
      await testSetup!.renderOnce();
    });

    expect(subscribeCalls).toBe(1);
    expect(unsubscribeCalls).toBe(0);

    await act(async () => {
      bumpHarness?.();
      await Promise.resolve();
    });
    await act(async () => {
      await testSetup!.renderOnce();
    });

    expect(subscribeCalls).toBe(1);
    expect(unsubscribeCalls).toBe(0);
  });

  test("uses forced polling instead of a subscription when live streaming is disabled", async () => {
    let subscribeCalls = 0;
    let loadCalls = 0;
    const coordinator = {
      subscribeQuotes: () => {
        subscribeCalls += 1;
        return () => {};
      },
      loadQuotesBatch: async (_instruments: unknown[], options: { forceRefresh?: boolean }) => {
        expect(options.forceRefresh).toBe(true);
        loadCalls += 1;
        return [];
      },
    };
    setSharedMarketDataCoordinator(coordinator as unknown as MarketDataCoordinator);

    testSetup = await testRender(<QuotePollingHarness />, { width: 20, height: 1 });
    await act(async () => testSetup!.renderOnce());
    expect(subscribeCalls).toBe(0);
    expect(loadCalls).toBe(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 45));
    });
    expect(loadCalls).toBeGreaterThanOrEqual(2);
  });

  test("does not restart polling when only subscription priority changes", async () => {
    let loadCalls = 0;
    const coordinator = {
      subscribeQuotes: () => () => {},
      loadQuotesBatch: async () => {
        loadCalls += 1;
        return [];
      },
    };
    setSharedMarketDataCoordinator(coordinator as unknown as MarketDataCoordinator);

    testSetup = await testRender(<QuotePollingPriorityHarness />, { width: 20, height: 1 });
    await act(async () => testSetup!.renderOnce());
    expect(loadCalls).toBe(1);

    await act(async () => {
      togglePollingPriority?.();
      await Promise.resolve();
    });
    await act(async () => testSetup!.renderOnce());
    expect(loadCalls).toBe(1);
  });

  test("keeps quote freshness stable while targets move within one surface", async () => {
    const originalDateNow = Date.now;
    let now = 100;
    Date.now = () => now;
    setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
      subscribeQuotes: () => () => {},
    })));

    try {
      testSetup = await testRender(<LiveQuoteFreshnessHarness />, {
        width: 20,
        height: 1,
      });
      await act(async () => {
        await testSetup!.renderOnce();
      });
      expect(observedSubscriptionStartedAt).toBe(100);

      now = 200;
      await act(async () => {
        updateLiveTargets?.("MSFT");
        await Promise.resolve();
        await testSetup!.renderOnce();
      });
      expect(observedSubscriptionStartedAt).toBe(100);

      now = 300;
      await act(async () => {
        updateFreshnessScope?.("expiration-2");
        await Promise.resolve();
        await testSetup!.renderOnce();
      });
      expect(observedSubscriptionStartedAt).toBe(300);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
