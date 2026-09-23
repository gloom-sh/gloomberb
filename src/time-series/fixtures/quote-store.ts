import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import type { InstrumentRef } from "../../market-data/request-types";
import { createIdleEntry, type QueryEntry } from "../../market-data/result-types";
import { buildQuoteKey } from "../../market-data/selectors";
import type { ChartQuoteStore } from "../live-quotes";

/** An in-memory quote store with the coordinator's key subscription contract. */
export function createQuoteStoreFixture(): ChartQuoteStore & {
  emit: (target: QuoteSubscriptionTarget | InstrumentRef, quote: Quote) => void;
  listenerCount: () => number;
} {
  const quotes = new Map<string, Quote>();
  const listeners = new Set<{ keys: ReadonlySet<string>; listener: () => void }>();
  const keyOf = (target: QuoteSubscriptionTarget | InstrumentRef) => buildQuoteKey("context" in target
    ? {
        symbol: target.symbol,
        exchange: target.exchange,
        brokerId: target.context?.brokerId,
        brokerInstanceId: target.context?.brokerInstanceId,
        instrument: target.context?.instrument ?? null,
      }
    : target);
  return {
    subscribeKeys(keys, listener) {
      const entry = { keys: new Set(keys), listener };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    getQuoteEntry(instrument): QueryEntry<Quote> {
      const quote = quotes.get(buildQuoteKey(instrument));
      return quote
        ? { ...createIdleEntry<Quote>(), phase: "ready", data: quote, lastGoodData: quote, source: "test", fetchedAt: Date.now() }
        : createIdleEntry<Quote>();
    },
    emit(target, quote) {
      const key = keyOf(target);
      quotes.set(key, quote);
      for (const entry of [...listeners]) {
        if (entry.keys.has(key)) entry.listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

/** The quote side of a partial coordinator fake: an empty store, no-op streams and polls. */
export const IDLE_COORDINATOR_QUOTES = {
  subscribeQuotes: () => Object.assign(() => {}, { update: () => {} }),
  subscribeKeys: () => () => {},
  getQuoteEntry: () => createIdleEntry<Quote>(),
  loadQuotesBatch: async () => [],
};
