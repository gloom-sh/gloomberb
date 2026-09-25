import { nextResponseSequence } from "./response-sequence";

/** A value's age belongs to its source, not to the consumer that last read it. */
export interface CachedValue<T> {
  value: T;
  fetchedAt: number;
  /** Process-local successful response order; absent on unsequenced hydrated cache. */
  responseSequence?: number;
  staleAt: number;
  expiresAt: number;
  source: string;
  /** Source observation time, when supplied; fetchedAt remains retrieval time. */
  asOf?: number;
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

/** Owns freshness, concurrent requests, stale fallback, and refresh notification. */
export class CachedQuery<T> implements CachedQueryHandle<T> {
  private state: CachedQueryState<T>;
  private readonly listeners = new Set<() => void>();
  private active: Promise<CachedValue<T>> | null = null;
  private generation = 0;

  constructor(private readonly options: {
    read: (allowExpired: boolean) => CachedValue<T> | null;
    fetch?: (force: boolean) => Promise<CachedValue<T>>;
    acceptCached?: (value: T) => boolean;
    /** Optional source-age/identity limit that also applies to stale fallback. */
    acceptResult?: (result: CachedValue<T>) => boolean;
  }) {
    this.state = { result: options.read(false), loading: false, error: null };
  }

  getSnapshot = (): CachedQueryState<T> => {
    if (this.state.result && !this.usable(this.state.result)) this.state = { ...this.state, result: null };
    return this.state;
  };

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
    const cached = this.usable(this.state.result) ?? this.usable(this.options.read(false));
    const acceptable = cached && (this.options.acceptCached?.(cached.value) ?? true);
    if (!force && acceptable && cached.staleAt > Date.now()) return Promise.resolve(cached);
    if (!this.active || replace) {
      if (!fetch) return Promise.reject(new Error("A cache miss requires a loader"));
      const generation = ++this.generation;
      this.publish({ result: cached, loading: true, error: null });
      const request = Promise.resolve().then(() => fetch(force)).then((result) => {
        if (generation !== this.generation) return result;
        const accepted = { ...result, responseSequence: nextResponseSequence() };
        this.publish({ result: accepted, loading: false, error: null });
        return accepted;
      }, (error: unknown) => {
        const fallback = this.usable(cached) ?? this.usable(this.options.read(true));
        const retained = fallback ? { ...fallback, refreshError: error } : null;
        if (generation === this.generation) this.publish({ result: retained, loading: false, error });
        if (retained) return retained;
        throw error;
      }).finally(() => {
        if (this.active === request) this.active = null;
      });
      this.active = request;
    }
    if (!force && acceptable && cached.expiresAt > Date.now() && background) {
      void this.active.catch(() => {});
      return Promise.resolve(cached);
    }
    return this.active;
  }
}
