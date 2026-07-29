import { describe, expect, test } from "bun:test";
import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import type { Quote } from "../../../../types/financials";
import { RemoteQuoteSubscriptionRegistry } from "./quote-subscription-registry";

const lowPriorityTarget: QuoteSubscriptionTarget = {
  symbol: "TSLA",
  exchange: "NASDAQ",
  surface: "watchlist",
  visible: true,
  selected: false,
  weight: 10,
};

const highPriorityTarget: QuoteSubscriptionTarget = {
  ...lowPriorityTarget,
  surface: "detail",
  selected: true,
  weight: 100,
};

const quote: Quote = {
  symbol: "TSLA",
  price: 250,
  currency: "USD",
  change: 5,
  changePercent: 2,
  lastUpdated: 1_700_000_000_000,
};

describe("RemoteQuoteSubscriptionRegistry", () => {
  test("recomputes the backend target and listener set when an overlapping subscription leaves", () => {
    let changes = 0;
    const lowEvents: Array<{ target: QuoteSubscriptionTarget; quote: Quote }> = [];
    const highEvents: Array<{ target: QuoteSubscriptionTarget; quote: Quote }> = [];
    const registry = new RemoteQuoteSubscriptionRegistry(() => { changes += 1; });

    const unsubscribeLow = registry.subscribe([lowPriorityTarget], (target, event) => lowEvents.push({ target, quote: event }));
    const unsubscribeHigh = registry.subscribe([highPriorityTarget], (target, event) => highEvents.push({ target, quote: event }));

    expect(registry.backendTargets()).toEqual([highPriorityTarget]);
    registry.dispatch(highPriorityTarget, quote);
    expect(lowEvents).toEqual([{ target: lowPriorityTarget, quote }]);
    expect(highEvents).toEqual([{ target: highPriorityTarget, quote }]);

    unsubscribeHigh();
    expect(registry.backendTargets()).toEqual([lowPriorityTarget]);
    registry.dispatch(lowPriorityTarget, quote);
    expect(lowEvents).toEqual([
      { target: lowPriorityTarget, quote },
      { target: lowPriorityTarget, quote },
    ]);
    expect(highEvents).toEqual([{ target: highPriorityTarget, quote }]);

    unsubscribeLow();
    expect(registry.backendTargets()).toEqual([]);
    expect(changes).toBe(4);
  });
});
