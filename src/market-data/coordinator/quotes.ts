import type { DataProvider, QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import type { InstrumentRef } from "../request-types";
import { mergeQuoteSubscriptionTargets } from "../quote-subscription-target";
import { QueryStore } from "../query-store";
import type { QueryEntry } from "../result-types";
import { buildQuoteKey, toMarketDataContext } from "../selectors";
import {
  EXPECTED_EMPTY,
  SNAPSHOT_CACHE_TTL_MS,
  classifyError,
  createAttempt,
  errorEntry,
  hasFreshQuoteEntry,
  loadingEntry,
  readyQuoteEntry,
} from "./entries";

export type QuoteSubscriptionPriority = Pick<QuoteSubscriptionTarget, "route" | "surface" | "visible" | "selected" | "weight">;

export interface QuoteSubscriptionEntry {
  target: QuoteSubscriptionTarget;
  targets: Map<number, QuoteSubscriptionTarget>;
  removeTimer: ReturnType<typeof setTimeout> | null;
}

const QUOTE_SUBSCRIPTION_REMOVE_GRACE_MS = 250;

const STREAM_QUOTE_FIELDS: Array<keyof Quote> = [
  "symbol",
  "providerId",
  "price",
  "currency",
  "change",
  "changePercent",
  "previousClose",
  "high52w",
  "low52w",
  "marketCap",
  "volume",
  "name",
  "exchangeName",
  "fullExchangeName",
  "listingExchangeName",
  "listingExchangeFullName",
  "routingExchangeName",
  "routingExchangeFullName",
  "marketState",
  "sessionConfidence",
  "preMarketPrice",
  "preMarketChange",
  "preMarketChangePercent",
  "postMarketPrice",
  "postMarketChange",
  "postMarketChangePercent",
  "bid",
  "ask",
  "bidSize",
  "askSize",
  "open",
  "high",
  "low",
  "mark",
  "dataSource",
  "delivery",
  "stale",
];

function quoteTargetFromInstrument(
  instrument: InstrumentRef,
  priority: QuoteSubscriptionPriority = {},
): QuoteSubscriptionTarget {
  return {
    symbol: instrument.symbol,
    exchange: instrument.exchange ?? "",
    context: toMarketDataContext(instrument),
    ...priority,
  };
}

type CoordinatorSingleFlight = <T>(key: string, task: () => Promise<T>) => Promise<T>;
type CoordinatorLoadOptions = { forceRefresh?: boolean };

interface LoadQuoteEntryOptions {
  dataProvider: DataProvider;
  instrument: InstrumentRef;
  options?: CoordinatorLoadOptions;
  quoteStore: QueryStore<Quote>;
  runSingleFlight: CoordinatorSingleFlight;
  resolveQuote?: (instrument: InstrumentRef, quote: Quote) => Quote;
}

export async function loadQuoteEntry({
  dataProvider,
  instrument,
  options = {},
  quoteStore,
  runSingleFlight,
  resolveQuote,
}: LoadQuoteEntryOptions): Promise<QueryEntry<Quote>> {
  const key = buildQuoteKey(instrument);
  const flightKey = options.forceRefresh ? `${key}|refresh` : key;
  return runSingleFlight(flightKey, async () => {
    quoteStore.update(key, loadingEntry);
    const startedAt = Date.now();
    try {
      const quote = await dataProvider.getQuote(
        instrument.symbol,
        instrument.exchange ?? "",
        {
          ...toMarketDataContext(instrument),
          cacheMode: options.forceRefresh ? "refresh" : "default",
        },
      );
      const resolvedQuote = resolveQuote?.(instrument, quote) ?? quote;
      const source = resolvedQuote.providerId ?? dataProvider.id;
      const attempts = [createAttempt(source, startedAt, "success")];
      return quoteStore.update(key, (current) => readyQuoteEntry(current, resolvedQuote, source, attempts));
    } catch (error) {
      const classified = classifyError(error);
      const attempt = createAttempt(dataProvider.id, startedAt, EXPECTED_EMPTY.test(classified.message) ? "empty" : "fatal_error", classified.reasonCode, classified.message);
      return quoteStore.update(key, (current) => errorEntry(current, attempt));
    }
  });
}

interface LoadQuoteBatchEntriesOptions {
  dataProvider: DataProvider;
  instruments: InstrumentRef[];
  options?: CoordinatorLoadOptions;
  quoteStore: QueryStore<Quote>;
  runSingleFlight: CoordinatorSingleFlight;
  resolveQuote?: (instrument: InstrumentRef, quote: Quote) => Quote;
}

export async function loadQuoteBatchEntries({
  dataProvider,
  instruments,
  options = {},
  quoteStore,
  runSingleFlight,
  resolveQuote,
}: LoadQuoteBatchEntriesOptions): Promise<QueryEntry<Quote>[]> {
  const uniqueInstruments = [...new Map(instruments.map((instrument) => [buildQuoteKey(instrument), instrument] as const)).values()];
  const results = new Map<string, QueryEntry<Quote>>();
  const misses: InstrumentRef[] = [];

  for (const instrument of uniqueInstruments) {
    const key = buildQuoteKey(instrument);
    const current = quoteStore.get(key);
    if (!options.forceRefresh && hasFreshQuoteEntry(current, instrument, SNAPSHOT_CACHE_TTL_MS)) {
      results.set(key, current);
    } else {
      misses.push(instrument);
    }
  }

  if (misses.length > 0 && dataProvider.getQuotesBatch) {
    const batchResults = await dataProvider.getQuotesBatch(
      misses.map((instrument) => quoteTargetFromInstrument(instrument)),
      { forceRefresh: options.forceRefresh },
    );
    batchResults.forEach((item, index) => {
      const instrument = misses[index];
      if (!instrument || !item.quote) return;
      const key = buildQuoteKey(instrument);
      const quote = resolveQuote?.(instrument, item.quote) ?? item.quote;
      const source = quote.providerId ?? dataProvider.id;
      const attempts = [createAttempt(source, Date.now(), "success")];
      results.set(key, quoteStore.update(key, (current) => readyQuoteEntry(current, quote, source, attempts)));
    });
  }

  await Promise.all(misses.map(async (instrument) => {
    const key = buildQuoteKey(instrument);
    if (results.has(key)) return;
    results.set(key, await loadQuoteEntry({
      dataProvider,
      instrument,
      options,
      quoteStore,
      runSingleFlight,
      resolveQuote,
    }));
  }));

  return instruments.map((instrument) => results.get(buildQuoteKey(instrument)) ?? quoteStore.get(buildQuoteKey(instrument)));
}

export class QuoteSubscriptionManager {
  private readonly quoteSubscriptions = new Map<string, QuoteSubscriptionEntry>();
  private nextQuoteSubscriptionId = 1;
  private quoteSubscriptionDispose: (() => void) | null = null;
  private quoteSubscriptionSignature = "";

  constructor(
    private readonly dataProvider: DataProvider,
    private readonly applyQuote: (instrument: InstrumentRef, quote: Quote) => void,
  ) {}

  subscribe(targets: Array<{ instrument: InstrumentRef; priority?: QuoteSubscriptionPriority }>): () => void {
    if (!this.dataProvider.subscribeQuotes || targets.length === 0) {
      return () => {};
    }

    const subscriptionId = this.nextQuoteSubscriptionId++;
    const subscribedKeys = new Set<string>();
    for (const { instrument, priority } of targets) {
      const key = buildQuoteKey(instrument);
      subscribedKeys.add(key);
      const target = quoteTargetFromInstrument(instrument, priority);
      const existing = this.quoteSubscriptions.get(key);
      if (existing) {
        existing.targets.set(subscriptionId, target);
        existing.target = mergeQuoteSubscriptionTargets(existing.targets.values()) ?? target;
        if (existing.removeTimer) {
          clearTimeout(existing.removeTimer);
          existing.removeTimer = null;
        }
        continue;
      }
      this.quoteSubscriptions.set(key, {
        target,
        targets: new Map([[subscriptionId, target]]),
        removeTimer: null,
      });
    }
    this.flush();

    return () => {
      for (const key of subscribedKeys) {
        const existing = this.quoteSubscriptions.get(key);
        if (!existing) continue;
        existing.targets.delete(subscriptionId);
        const mergedTarget = mergeQuoteSubscriptionTargets(existing.targets.values());
        if (mergedTarget) {
          existing.target = mergedTarget;
          this.flush();
          continue;
        }
        if (existing.removeTimer) continue;
        existing.removeTimer = setTimeout(() => {
          const current = this.quoteSubscriptions.get(key);
          if (!current || current.targets.size > 0) return;
          this.quoteSubscriptions.delete(key);
          this.flush();
        }, QUOTE_SUBSCRIPTION_REMOVE_GRACE_MS);
      }
    };
  }

  private flush(): void {
    if (!this.dataProvider.subscribeQuotes) return;

    const activeEntries = [...this.quoteSubscriptions.entries()]
      .filter(([, entry]) => entry.targets.size > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    const nextSignature = activeEntries.map(([key, entry]) => [
      key,
      entry.target.route ?? "",
      entry.target.surface ?? "",
      entry.target.visible ? "visible" : "",
      entry.target.selected ? "selected" : "",
      Number.isFinite(entry.target.weight) ? entry.target.weight : "",
    ].join(":")).join("|");
    if (nextSignature === this.quoteSubscriptionSignature) return;

    this.quoteSubscriptionDispose?.();
    this.quoteSubscriptionDispose = null;
    this.quoteSubscriptionSignature = nextSignature;

    const targets = activeEntries.map(([, entry]) => entry.target);
    if (targets.length === 0) return;

    this.quoteSubscriptionDispose = this.dataProvider.subscribeQuotes(targets, (target, quote) => {
      const instrument: InstrumentRef = {
        symbol: target.symbol,
        exchange: target.exchange ?? "",
        brokerId: target.context?.brokerId,
        brokerInstanceId: target.context?.brokerInstanceId,
        instrument: target.context?.instrument ?? null,
      };
      this.applyQuote(instrument, quote);
    });
  }
}

export function areStreamQuotesEquivalent(current: Quote | null | undefined, next: Quote): boolean {
  if (!current) return false;
  for (const field of STREAM_QUOTE_FIELDS) {
    if (current[field] !== next[field]) return false;
  }
  return current.lastUpdated === next.lastUpdated
    && JSON.stringify(current.provenance ?? null) === JSON.stringify(next.provenance ?? null);
}
