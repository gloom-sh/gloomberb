import { expect, test } from "bun:test";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createManualFrameDriver, DataFrameScheduler } from "../../../market-data/frame-scheduler";
import { buildQuoteKey } from "../../../market-data/selectors";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { createAlertQuoteStream } from "./live";
import type { AlertRule } from "./types";
import { useAlertTestClock } from "./test-fixture";

useAlertTestClock();

test("ticks a symbol gathered stay to be judged when the alerts it is followed for change, and go with a symbol no alert follows", () => {
  let emit: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
  let streamed: QuoteSubscriptionTarget[] = [];
  const clock = createManualFrameDriver(100);
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    subscribeQuotes: (targets, onQuote) => { streamed = targets; emit = onQuote; return () => {}; },
  }), { frames: new DataFrameScheduler(clock.driver) });
  setSharedMarketDataCoordinator(coordinator);
  const rule = (symbol: string): AlertRule => ({
    id: symbol, symbol, exchange: "NASDAQ", condition: "crosses", targetPrice: 100, createdAt: 1, status: "active",
  });
  let alerts = [rule("AAPL"), rule("MSFT")];
  // Nothing takes the ticks as they are heard: the check after the change does.
  const stream = createAlertQuoteStream({ readAlerts: () => alerts, onQuotes: () => {} });
  const tick = (symbol: string, price: number) => emit!(streamed.find((target) => target.symbol === symbol)!, {
    symbol, price, change: 0, changePercent: 0, currency: "USD", lastUpdated: Date.now(), delivery: "stream", dataSource: "live", marketState: "REGULAR",
  } as Quote);
  try {
    for (const symbol of ["AAPL", "MSFT"]) tick(symbol, 99);
    clock.advance(1_000);
    // Each crosses and comes back before its next apply.
    for (const symbol of ["AAPL", "MSFT"]) { tick(symbol, 101); tick(symbol, 99.5); }
    clock.advance(1_000);
    // An alert on NVDA is added and the one on MSFT deleted before the next check.
    alerts = [rule("AAPL"), rule("NVDA")];
    stream.sync();
    const taken = stream.takeTicks();
    const aapl = buildQuoteKey({ symbol: "AAPL", exchange: "NASDAQ" });
    expect([...taken.keys()]).toEqual([aapl]);
    expect(taken.get(aapl)).toMatchObject({ low: { price: 99.5 }, high: { price: 101 }, last: 99.5 });
  } finally {
    stream.dispose();
    coordinator.destroy();
    setSharedMarketDataCoordinator(null);
  }
});
