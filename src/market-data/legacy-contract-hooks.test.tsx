import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { useQuoteStreaming } from "../state/hooks/quote-streaming";
import { createTestDataProvider } from "../test-support/data-provider";
import type { TickerRecord } from "../types/ticker";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "./coordinator";
import { useQuoteEntry, useTickerFinancials, useTickerFinancialsMap } from "./hooks";
import { quoteSubscriptionTargetFromTicker } from "./request-types";
import { createTestTicker } from "../test-support/ticker";

const tui = createOpenTuiTestHarness();
let coordinator: MarketDataCoordinator | undefined;
afterEach(async () => {
  coordinator?.destroy(); coordinator = undefined; setSharedMarketDataCoordinator(null);
  await new Promise(resolve => setTimeout(resolve, 260));
});

test.each([false, true])("hooks reload and resubscribe when a supplied definition changes; localSymbol=%s", async (hasLocalSymbol) => {
  const ticker = (strike: number): TickerRecord => (createTestTicker("ACME", "ACME", {
    portfolios: ["p"],
    positions: [{ portfolio: "p", shares: 1, broker: "fixture", brokerInstanceId: "feed" }],
    broker_contracts: [{ brokerId: "fixture", brokerInstanceId: "feed", symbol: "ACME", localSymbol: hasLocalSymbol ? "LEGACY" : undefined, secType: "OPT", currency: "USD", lastTradeDateOrContractMonth: "20261016", right: "C", strike, multiplier: "100" }],
  }));
  const quote = (strike: number) => ({ symbol: "ACME", currency: "USD", price: strike / 10, change: 0, changePercent: 0, lastUpdated: Date.now() });
  const snapshots: number[] = []; const subscriptions: number[][] = [];
  coordinator = new MarketDataCoordinator(createTestDataProvider({
    getQuote: async (_s, _e, context) => quote(context!.instrument!.strike!),
    getTickerFinancials: async (_s, _e, context) => { const strike = context!.instrument!.strike!; snapshots.push(strike); return { quote: quote(strike), annualStatements: [], quarterlyStatements: [], priceHistory: [] }; },
    subscribeQuotes: targets => { subscriptions.push(targets.map(t => t.context!.instrument!.strike!)); return () => {}; },
  }));
  setSharedMarketDataCoordinator(coordinator);
  let replace: (ticker: TickerRecord) => void = () => {}; let observed: unknown;
  function Harness() {
    const [current, setCurrent] = useState(ticker(100)); replace = setCurrent;
    const quoteEntry = useQuoteEntry("ACME", current);
    const financials = useTickerFinancials("ACME", current);
    const map = useTickerFinancialsMap([current], { portfolioId: "p" });
    useQuoteStreaming([quoteSubscriptionTargetFromTicker(current)!]);
    observed = [quoteEntry?.data?.price, financials?.quote?.price, map.get("ACME")?.quote?.price];
    return <text>{JSON.stringify(observed)}</text>;
  }
  await tui.render(<Harness />, { width: 48, height: 2 });
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); }); await act(async () => { await tui.setup().renderOnce(); }); };
  await settle(); expect(observed).toEqual([10, 10, 10]);
  await act(async () => replace(ticker(110))); await settle();
  expect(observed).toEqual([11, 11, 11]); expect(snapshots).toEqual([100, 110]);
  expect(subscriptions).toEqual([[100], [110]]);
});
