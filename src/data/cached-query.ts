import type { QuoteIntradayBar } from "../types/financials";
import { nextResponseSequence } from "./response-sequence";
import { markSavedCopy, noteServedCopy, savedCopyAt, servedFromSavedCopy, stampRetrievedAt } from "./saved-copies";

/** A value's age belongs to its source, not to the consumer that last read it. */
export interface CachedValue<T> {
  value: T;
  fetchedAt: number;
  /** Process-local successful response order; absent on unsequenced hydrated cache. */
  responseSequence?: number;
  staleAt: number;
  expiresAt: number;
  fallbackOnly?: true;
  source: string;
  /** Source observation time, when supplied; fetchedAt remains retrieval time. */
  asOf?: number;
  /** How far a delayed source runs behind the market, in minutes; 0 for a real-time one. */
  delayMinutes?: number;
  /** Exchange rates: the pair's bar the rate is the close of, when it is not a print. */
  intradayBar?: QuoteIntradayBar;
  /** Exchange rates: why a stale rate stands, as the data service states it. */
  staleReason?: string;
  refreshError?: unknown;
}

export interface CachedQueryState<T> {
  result: CachedValue<T> | null;
  loading: boolean;
  error: unknown;
}

export interface CachedQueryHandle<T> {
  getSnapshot(): CachedQueryState<T>;
  subscribe(listener: () => void): () => void;
  load(options?: { force?: boolean; background?: boolean; replace?: boolean }): Promise<CachedValue<T>>;
}

export function cachedValueSavedAt(result: CachedValue<unknown> | null | undefined): number | null {
  if (!result) return null;
  return result.fallbackOnly || result.refreshError !== undefined || result.expiresAt <= Date.now()
    ? result.fetchedAt : savedCopyAt(result.value);
}

/** Read a cache seed without losing the age that an async pane uses in its footer. */
export function cachedValueForDisplay<T>(result: CachedValue<T> | null | undefined): T | null {
  if (!result) return null;
  const savedAt = cachedValueSavedAt(result);
  return savedAt === null ? result.value : markDisplayedValue(result.value, savedAt);
}

function markDisplayedValue<T>(value: T, savedAt: number): T {
  return value && typeof value === "object" && savedCopyAt(value) !== savedAt ? markSavedCopy(value, savedAt) : value;
}

/** Owns freshness, concurrent requests, stale fallback, and refresh notification. */
export class CachedQuery<T> implements CachedQueryHandle<T> {
  private state: CachedQueryState<T>;
  private readonly listeners = new Set<() => void>();
  private active: Promise<CachedValue<T>> | null = null;
  private generation = 0;
  private fallbackOnly = false;

  constructor(private readonly options: {
    read: (allowExpired: boolean) => CachedValue<T> | null;
    fetch?: (force: boolean) => Promise<CachedValue<T>>;
    acceptCached?: (value: T) => boolean;
    /** Optional source-age/identity limit that also applies to stale fallback. */
    acceptResult?: (result: CachedValue<T>) => boolean;
    /**
     * The value is a dataset dated by when it was read (a holder or filing
     * list), not by an observation time of its own: a copy served without
     * asking the source is stamped with when it was read, and a command notes
     * it (data/saved-copies.ts `RETRIEVED_AT`).
     */
    datedByRetrieval?: boolean;
  }) {
    const result = options.read(true);
    this.fallbackOnly = result !== null && (result.fallbackOnly === true || result.expiresAt <= Date.now());
    this.state = { result, loading: false, error: null };
  }

  getSnapshot = (): CachedQueryState<T> => {
    if (this.state.result && !this.usable(this.state.result)) this.state = { ...this.state, result: null };
    return this.state;
  };

  /** A copy answered without a fetch in this load: dated by when it was read, where the query is (`datedByRetrieval`). */
  private servedCopy(result: CachedValue<T>, refreshFailed: boolean): CachedValue<T> {
    if (!this.options.datedByRetrieval) return result;
    noteServedCopy(result.fetchedAt, refreshFailed);
    if (refreshFailed) return result;
    const value = stampRetrievedAt(result.value, result.fetchedAt);
    return value === result.value ? result : { ...result, value };
  }

  private usable(result: CachedValue<T> | null): CachedValue<T> | null {
    return result && (this.options.acceptResult?.(result) ?? true) ? result : null;
  }

  /** True while something listens or a load is running; an idle query can be dropped and rebuilt from the cache. */
  get inUse(): boolean {
    return this.listeners.size > 0 || this.active !== null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(state: CachedQueryState<T>): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.generation += 1;
    this.active = null;
    this.listeners.clear();
  }

  load({ force = false, background = false, replace = false, fetch = this.options.fetch }: {
    force?: boolean;
    background?: boolean;
    replace?: boolean;
    fetch?: (force: boolean) => Promise<CachedValue<T>>;
  } = {}): Promise<CachedValue<T>> {
    const previous = this.usable(this.state.result);
    const cached = (this.fallbackOnly ? null : previous) ?? this.usable(this.options.read(false));
    const acceptable = cached && (this.options.acceptCached?.(cached.value) ?? true);
    if (!force && acceptable && Math.min(cached.staleAt, cached.expiresAt) > Date.now()) return Promise.resolve(this.servedCopy(cached, false));
    if (!this.active || replace) {
      if (!fetch) return Promise.reject(new Error("A cache miss requires a loader"));
      const generation = ++this.generation;
      this.publish({ result: cached ?? previous, loading: true, error: null });
      const request = Promise.resolve().then(() => fetch(force)).then((result) => {
        if (generation !== this.generation) return result;
        const accepted = { ...result, responseSequence: nextResponseSequence() };
        this.fallbackOnly = false;
        this.publish({ result: accepted, loading: false, error: null });
        return accepted;
      }, (error: unknown) => {
        const fallback = this.usable(cached ?? previous) ?? this.usable(this.options.read(true));
        // A command that shows it says it is the saved copy (`servedFromSavedCopy`).
        const retained = fallback ? { ...fallback,
          value: markDisplayedValue(servedFromSavedCopy(fallback.value, fallback.fetchedAt), fallback.fetchedAt), refreshError: error } : null;
        if (generation === this.generation) {
          this.fallbackOnly = cached === null && retained !== null;
          this.publish({ result: retained, loading: false, error });
        }
        if (retained) return this.servedCopy(retained, true);
        throw error;
      }).finally(() => {
        if (this.active === request) this.active = null;
      });
      this.active = request;
    }
    if (!force && acceptable && cached.expiresAt > Date.now() && background) {
      void this.active.catch(() => { /* Intentional ignore: The request rejection already publishes CachedQuery.error to subscribers. */ });
      return Promise.resolve(this.servedCopy(cached, false));
    }
    return this.active;
  }
}
