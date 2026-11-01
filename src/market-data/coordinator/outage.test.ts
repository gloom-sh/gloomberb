import { describe, expect, it } from "bun:test";
import { useRegularMarketSession } from "../../test-support/market-session";
import { createTestDataProvider, createTestFinancials } from "../../test-support/data-provider";
import { createManualFrameDriver, DataFrameScheduler } from "../frame-scheduler";
import { buildChartKey, buildSnapshotKey } from "../selectors";
import { createBaselineChartRequest } from "./chart";
import { MarketDataCoordinator } from "./index";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { DataServiceUnreachableError } from "../../utils/network-failure";

useRegularMarketSession();

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function quote(price: number, lastUpdated: number): Quote {
  return { symbol: "AMGN", providerId: "gloomberb-cloud", price, currency: "USD", change: 1, changePercent: 0.3, lastUpdated };
}

describe("MarketDataCoordinator after an outage", () => {
  // A chart whose history failed while the network was down stayed blank for
  // minutes after prices ticked again: the failure held the next load back,
  // and nothing asked again until the user moved to another ticker and back.
  it("asks again for what a pane shows that failed, and stops holding back what it left", async () => {
    let online = false;
    const asked: string[] = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async (symbol) => {
        asked.push(`financials ${symbol}`);
        if (!online) throw new DataServiceUnreachableError(new Error("Unable to connect"));
        return createTestFinancials({ quote: quote(447, Date.now()) });
      },
      getPriceHistory: async (symbol) => {
        asked.push(`history ${symbol}`);
        if (!online) throw new DataServiceUnreachableError(new Error("Unable to connect"));
        return [{ date: new Date("2026-09-11"), close: 440 }, { date: new Date("2026-09-14"), close: 447 }];
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const shown = { symbol: "AMGN", exchange: "NASDAQ" };
    const left = { symbol: "AMD", exchange: "NASDAQ" };
    const chart = createBaselineChartRequest(shown);
    // The pane shows AMGN; AMD was passed over during the outage.
    const stopWatching = coordinator.subscribeKeys([buildSnapshotKey(shown), buildChartKey(chart)], () => {});

    expect((await coordinator.loadSnapshot(shown)).phase).toBe("error");
    expect((await coordinator.loadChart(chart)).phase).toBe("error");
    expect((await coordinator.loadSnapshot(left)).phase).toBe("error");
    // A failure a moment ago holds an unforced load back.
    await coordinator.loadSnapshot(shown);
    expect(asked).toEqual(["financials AMGN", "history AMGN", "financials AMD"]);

    online = true;
    asked.length = 0;
    coordinator.reloadAfterOutage();
    await settle();
    expect(asked.sort()).toEqual(["financials AMGN", "history AMGN"]);
    expect(coordinator.getSnapshotEntry(shown).phase).toBe("ready");
    expect(coordinator.getChartEntry(chart).data?.length).toBe(2);

    // Moving back to a ticker that failed in the outage loads it at once.
    expect((await coordinator.loadSnapshot(left)).phase).toBe("ready");
    stopWatching();
  });
});

describe("MarketDataCoordinator while the quote stream is down", () => {
  // A half-open link froze prices for over a minute while the pane still read as live.
  it("reads a streamed price as stale, never handing it back to an older snapshot's, and live again once the stream runs", async () => {
    const clock = createManualFrameDriver(0);
    let streamed: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
    const opened = Date.now() - 30 * 60_000;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => createTestFinancials({ quote: quote(440, opened) }),
      subscribeQuotes: (_targets, onQuote) => {
        streamed = onQuote;
        return () => {};
      },
    });
    const coordinator = new MarketDataCoordinator(provider, { frames: new DataFrameScheduler(clock.driver) });
    const instrument = { symbol: "AMGN", exchange: "NASDAQ" };
    await coordinator.loadSnapshot(instrument);
    const stopStreaming = coordinator.subscribeQuotes([{ instrument }]);
    streamed!({ symbol: "AMGN", exchange: "NASDAQ" }, quote(447.3, Date.now()));
    clock.advance(0);
    expect(coordinator.getTickerFinancialsSync(instrument)?.quote?.price).toBe(447.3);

    coordinator.setQuoteStreamDown(Date.now());
    const frozen = coordinator.getTickerFinancialsSync(instrument)?.quote;
    expect(frozen?.price).toBe(447.3);
    expect(frozen?.stale).toBe(true);
    expect(coordinator.getQuoteEntry(instrument).data?.stale).toBe(true);
    // One identity per entry while nothing moves, for readers that memoize on it.
    expect(coordinator.getQuoteEntry(instrument)).toBe(coordinator.getQuoteEntry(instrument));

    coordinator.setQuoteStreamDown(null);
    expect(coordinator.getTickerFinancialsSync(instrument)?.quote?.stale).toBeUndefined();
    expect(coordinator.getQuoteEntry(instrument).data?.stale).toBeUndefined();
    stopStreaming();
  });
});
