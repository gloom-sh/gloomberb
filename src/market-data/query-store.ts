import type { QueryEntry } from "./result-types";
import { createIdleEntry } from "./result-types";

/** How many entries a store keeps once nothing is watching them. */
export interface QueryStoreRetention {
  /**
   * Entries to keep once nothing on screen is watching them, on top of the
   * watched ones. Browsing a ticker adds an entry to every store its panes
   * touch, and nothing used to remove one, so a session that researched a few
   * hundred symbols held every price history, statement set and filing it had
   * ever shown until exit (#452).
   */
  maxRetainedEntries?: number;
  /** True while a mounted pane is subscribed to this key, so it must be kept. */
  isWatched?: (key: string) => boolean;
  /** Called for each evicted key, for anything derived from it and keyed alike. */
  onEvict?: (key: string) => void;
}

export interface QueryStoreOptions<T> extends QueryStoreRetention {
  /**
   * Sees every entry before it is stored, so a store can overlay a newer
   * source (a streamed FX rate over a loaded one) on whatever writes it.
   */
  project?: (key: string, entry: QueryEntry<T>) => QueryEntry<T>;
}

export class QueryStore<T> {
  private readonly entries = new Map<string, QueryEntry<T>>();
  /** Stored keys no pane is watching, least recently used first. */
  private readonly unwatched = new Set<string>();

  constructor(
    private readonly onChange: (key: string) => void,
    private readonly options: QueryStoreOptions<T> = {},
  ) {}

  get(key: string): QueryEntry<T> {
    return this.entries.get(key) ?? createIdleEntry<T>();
  }

  set(key: string, entry: QueryEntry<T>): void {
    this.store(key, entry);
    this.onChange(key);
  }

  update(key: string, updater: (current: QueryEntry<T>) => QueryEntry<T>): QueryEntry<T> {
    const next = this.store(key, updater(this.get(key)));
    this.onChange(key);
    return next;
  }

  /** A pane started watching `key`, so it is kept until released. */
  watch(key: string): void {
    this.unwatched.delete(key);
  }

  /** The last pane watching `key` let go: it is now the most recently used entry. */
  release(key: string): void {
    if (this.entries.has(key)) this.retain(key);
  }

  /** Entries held right now. */
  get size(): number {
    return this.entries.size;
  }

  private store(key: string, entry: QueryEntry<T>): QueryEntry<T> {
    const next = this.options.project ? this.options.project(key, entry) : entry;
    this.entries.set(key, next);
    this.retain(key);
    return next;
  }

  /**
   * Marks an unwatched key as the most recently used and drops the least
   * recently used unwatched entries past the ceiling. A watched key is never
   * evicted and does not count, so a pane cannot blank and a large portfolio
   * still leaves room to go back to the tickers just browsed. An evicted key
   * returns to idle and refetches the next time something asks for it.
   */
  private retain(key: string): void {
    const limit = this.options.maxRetainedEntries;
    if (limit === undefined) return;
    this.unwatched.delete(key);
    if (this.options.isWatched?.(key)) return;
    this.unwatched.add(key);
    for (const oldest of this.unwatched) {
      if (this.unwatched.size <= limit) return;
      this.unwatched.delete(oldest);
      this.entries.delete(oldest);
      this.options.onEvict?.(oldest);
    }
  }
}
