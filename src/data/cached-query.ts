/** A value's age belongs to its source, not to the consumer that last read it. */
export interface CachedValue<T> {
  value: T;
  fetchedAt: number;
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
  }) {
    this.state = { result: options.read(false), loading: false, error: null };
  }

  getSnapshot = (): CachedQueryState<T> => this.state;

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
    const cached = this.state.result ?? this.options.read(false);
    const acceptable = cached && (this.options.acceptCached?.(cached.value) ?? true);
    if (!force && acceptable && cached.staleAt > Date.now()) return Promise.resolve(cached);
    if (!this.active || replace) {
      if (!fetch) return Promise.reject(new Error("A cache miss requires a loader"));
      const generation = ++this.generation;
      this.publish({ result: cached, loading: true, error: null });
      const request = Promise.resolve().then(() => fetch(force)).then((result) => {
        if (generation === this.generation) this.publish({ result, loading: false, error: null });
        return result;
      }, (error: unknown) => {
        const fallback = cached ?? this.options.read(true);
        if (generation === this.generation) this.publish({ result: fallback, loading: false, error });
        if (fallback) return { ...fallback, refreshError: error };
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
