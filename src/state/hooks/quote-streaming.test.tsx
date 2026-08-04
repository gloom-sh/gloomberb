import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../market-data/coordinator";
import { createTestDataProvider } from "../../test-support/data-provider";
import { useLiveQuoteEntries, useQuoteStreaming } from "./quote-streaming";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let bumpHarness: (() => void) | null = null;
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
