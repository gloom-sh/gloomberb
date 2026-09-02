import type { DataProvider, QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import type { InstrumentRef } from "../request-types";
import { QUOTE_STREAM_UPDATE_THROTTLE_MS } from "../quotes/cadence";
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

export interface QuoteSubscriptionRequest {
  instrument: InstrumentRef;
  priority?: QuoteSubscriptionPriority;
}

/**
 * Remains callable for compatibility with the original disposer API. Updating
 * the handle lets long-lived consumers change priorities without unregistering
 * their whole target set first.
 */
export interface QuoteSubscriptionHandle {
  (): void;
  update(targets: QuoteSubscriptionRequest[]): void;
}

export interface QuoteSubscriptionEntry {
  target: QuoteSubscriptionTarget;
  targets: Map<number, QuoteSubscriptionTarget>;
  removeTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingStreamQuote {
  instrument: InstrumentRef;
  quote: Quote;
}

export const QUOTE_SUBSCRIPTION_REMOVE_GRACE_MS = 250;
export const QUOTE_SUBSCRIPTION_PRIORITY_UPDATE_DELAY_MS = 100;

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
  private readonly pendingStreamQuotes = new Map<string, PendingStreamQuote>();
  private lastStreamQuoteBatchAppliedAt: number | null = null;
  private pendingStreamQuoteTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPriorityUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private nextQuoteSubscriptionId = 1;
  private quoteSubscriptionDispose: (() => void) | null = null;
  private quoteSubscriptionSignature = "";
  private quoteSubscriptionRoutingSignature = "";

  constructor(
    private readonly dataProvider: DataProvider,
    private readonly applyQuote: (instrument: InstrumentRef, quote: Quote) => void,
  ) {}

  subscribe(targets: QuoteSubscriptionRequest[]): QuoteSubscriptionHandle {
    if (!this.dataProvider.subscribeQuotes) {
      return this.createNoopSubscription();
    }

    const subscriptionId = this.nextQuoteSubscriptionId++;
    let subscribedKeys = new Set<string>();
    let disposed = false;
    const update = (nextTargets: QuoteSubscriptionRequest[]) => {
      if (disposed) return;
      subscribedKeys = this.updateSubscriptionTargets(subscriptionId, subscribedKeys, nextTargets);
    };
    const dispose = (() => {
      if (disposed) return;
      disposed = true;
      subscribedKeys = this.updateSubscriptionTargets(subscriptionId, subscribedKeys, []);
    }) as QuoteSubscriptionHandle;
    dispose.update = update;
    update(targets);
    return dispose;
  }

  private createNoopSubscription(): QuoteSubscriptionHandle {
    const dispose = (() => {}) as QuoteSubscriptionHandle;
    dispose.update = () => {};
    return dispose;
  }

  private updateSubscriptionTargets(
    subscriptionId: number,
    subscribedKeys: Set<string>,
    targets: QuoteSubscriptionRequest[],
  ): Set<string> {
    const nextTargets = new Map<string, QuoteSubscriptionTarget>();
    for (const { instrument, priority } of targets) {
      const key = buildQuoteKey(instrument);
      const target = quoteTargetFromInstrument(instrument, priority);
      const duplicate = nextTargets.get(key);
      nextTargets.set(
        key,
        duplicate
          ? mergeQuoteSubscriptionTargets([duplicate, target]) ?? target
          : target,
      );
    }

    const nextKeys = new Set(nextTargets.keys());
    const affectedKeys = new Set([...subscribedKeys, ...nextKeys]);
    let shouldFlush = false;
    for (const key of affectedKeys) {
      const nextTarget = nextTargets.get(key);
      let entry = this.quoteSubscriptions.get(key);
      if (nextTarget) {
        if (!entry) {
          entry = {
            target: nextTarget,
            targets: new Map(),
            removeTimer: null,
          };
          this.quoteSubscriptions.set(key, entry);
        }
        entry.targets.set(subscriptionId, nextTarget);
        if (entry.removeTimer) {
          clearTimeout(entry.removeTimer);
          entry.removeTimer = null;
        }
      } else if (entry) {
        entry.targets.delete(subscriptionId);
      }
      if (!entry) continue;

      const mergedTarget = mergeQuoteSubscriptionTargets(entry.targets.values());
      if (mergedTarget) {
        entry.target = mergedTarget;
        shouldFlush = true;
        continue;
      }
      this.scheduleSubscriptionRemoval(key, entry);
    }
    if (shouldFlush) {
      this.flush();
    } else if (![...this.quoteSubscriptions.values()].some((entry) => entry.targets.size > 0)) {
      this.cancelPendingPriorityUpdate();
    }
    return nextKeys;
  }

  private scheduleSubscriptionRemoval(key: string, entry: QuoteSubscriptionEntry): void {
    if (entry.removeTimer) return;
    this.clearPendingStreamQuote(key);
    entry.removeTimer = setTimeout(() => {
      const current = this.quoteSubscriptions.get(key);
      if (!current || current.targets.size > 0) return;
      this.quoteSubscriptions.delete(key);
      this.clearPendingStreamQuote(key);
      this.flush();
    }, QUOTE_SUBSCRIPTION_REMOVE_GRACE_MS);
  }

  private flush({
    coalescePriorityChanges = true,
    requireStableRouting = false,
  }: {
    coalescePriorityChanges?: boolean;
    requireStableRouting?: boolean;
  } = {}): void {
    if (!this.dataProvider.subscribeQuotes) return;

    const activeEntries = [...this.quoteSubscriptions.entries()]
      .filter(([, entry]) => entry.targets.size > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    const nextRoutingSignature = JSON.stringify(activeEntries.map(([key, entry]) => [
      key,
      entry.target.route ?? "auto",
    ]));
    const nextSignature = JSON.stringify(activeEntries.map(([key, entry]) => [
      key,
      entry.target.route ?? "auto",
      entry.target.surface ?? "",
      entry.target.visible === true,
      entry.target.selected === true,
      Number.isFinite(entry.target.weight) ? entry.target.weight : null,
    ]));
    if (nextSignature === this.quoteSubscriptionSignature) {
      this.cancelPendingPriorityUpdate();
      return;
    }
    if (requireStableRouting && nextRoutingSignature !== this.quoteSubscriptionRoutingSignature) {
      return;
    }

    const priorityOnlyChange = this.quoteSubscriptionSignature.length > 0
      && nextRoutingSignature === this.quoteSubscriptionRoutingSignature;
    if (coalescePriorityChanges && priorityOnlyChange) {
      this.schedulePriorityUpdate();
      return;
    }
    this.cancelPendingPriorityUpdate();

    const targets = activeEntries.map(([, entry]) => entry.target);
    const nextDispose = targets.length > 0
      ? this.dataProvider.subscribeQuotes(targets, (target, quote) => {
          const instrument: InstrumentRef = {
            symbol: target.symbol,
            exchange: target.exchange ?? "",
            brokerId: target.context?.brokerId,
            brokerInstanceId: target.context?.brokerInstanceId,
            instrument: target.context?.instrument ?? null,
          };
          this.enqueueStreamQuote(instrument, quote);
        })
      : null;
    // Register first so the cloud socket and desktop registries can merge the
    // overlapping listeners without observing a zero-listener disconnect.
    const previousDispose = this.quoteSubscriptionDispose;
    this.quoteSubscriptionDispose = nextDispose;
    this.quoteSubscriptionSignature = nextSignature;
    this.quoteSubscriptionRoutingSignature = nextRoutingSignature;
    previousDispose?.();
  }

  private schedulePriorityUpdate(): void {
    // Do not reset this timer. Continuous navigation must still publish the
    // latest priorities instead of postponing them indefinitely.
    if (this.pendingPriorityUpdateTimer !== null) return;
    this.pendingPriorityUpdateTimer = setTimeout(() => {
      this.pendingPriorityUpdateTimer = null;
      this.flush({ coalescePriorityChanges: false, requireStableRouting: true });
    }, QUOTE_SUBSCRIPTION_PRIORITY_UPDATE_DELAY_MS);
  }

  private cancelPendingPriorityUpdate(): void {
    if (this.pendingPriorityUpdateTimer === null) return;
    clearTimeout(this.pendingPriorityUpdateTimer);
    this.pendingPriorityUpdateTimer = null;
  }

  private enqueueStreamQuote(instrument: InstrumentRef, quote: Quote): void {
    const key = buildQuoteKey(instrument);
    const subscription = this.quoteSubscriptions.get(key);
    if (!subscription || subscription.targets.size === 0) return;

    this.pendingStreamQuotes.set(key, { instrument, quote });
    const elapsed = this.lastStreamQuoteBatchAppliedAt == null
      ? Number.POSITIVE_INFINITY
      : Date.now() - this.lastStreamQuoteBatchAppliedAt;
    if (elapsed >= QUOTE_STREAM_UPDATE_THROTTLE_MS) {
      this.flushPendingStreamQuotes();
      return;
    }
    this.schedulePendingStreamQuoteFlush(QUOTE_STREAM_UPDATE_THROTTLE_MS - elapsed);
  }

  private schedulePendingStreamQuoteFlush(delayMs: number): void {
    if (this.pendingStreamQuoteTimer !== null) return;
    this.pendingStreamQuoteTimer = setTimeout(() => {
      this.pendingStreamQuoteTimer = null;
      this.flushPendingStreamQuotes();
    }, Math.max(0, delayMs));
  }

  private flushPendingStreamQuotes(): void {
    const pendingQuotes = [...this.pendingStreamQuotes.entries()];
    this.pendingStreamQuotes.clear();
    if (this.pendingStreamQuoteTimer !== null) clearTimeout(this.pendingStreamQuoteTimer);
    this.pendingStreamQuoteTimer = null;
    if (pendingQuotes.length === 0) return;

    this.lastStreamQuoteBatchAppliedAt = Date.now();
    for (const [key, pending] of pendingQuotes) {
      const subscription = this.quoteSubscriptions.get(key);
      if (subscription?.targets.size) {
        this.applyQuote(pending.instrument, pending.quote);
      }
    }
  }

  private clearPendingStreamQuote(key: string): void {
    this.pendingStreamQuotes.delete(key);
    if (this.pendingStreamQuotes.size === 0 && this.pendingStreamQuoteTimer !== null) {
      clearTimeout(this.pendingStreamQuoteTimer);
      this.pendingStreamQuoteTimer = null;
    }
    if (![...this.quoteSubscriptions.values()].some((entry) => entry.targets.size > 0)) {
      this.lastStreamQuoteBatchAppliedAt = null;
    }
  }
}

export function areStreamQuotesEquivalent(current: Quote | null | undefined, next: Quote): boolean {
  if (!current) return false;
  for (const field of STREAM_QUOTE_FIELDS) {
    if (current[field] !== next[field]) return false;
  }
  return current.lastUpdated === next.lastUpdated
    && current.receivedAt === next.receivedAt
    && JSON.stringify(current.provenance ?? null) === JSON.stringify(next.provenance ?? null);
}
