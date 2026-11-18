import type { QueryEntry } from "./result-types";
import { createIdleEntry } from "./result-types";
import { readSavedCopy, writeSavedCopy } from "../data/pane-saved-copies";

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
  /**
   * Keeps each answer as a saved copy under this name (data/pane-saved-copies.ts):
   * a key nothing has loaded yet this run starts from its copy, of any age, as
   * `data` in a ready entry. Freshness checks still require a new answer.
   */
  savedCopies?: { name: string; version?: number; writeIntervalMs?: number; mark?: (value: T, at: number) => T };
}

/** What a saved copy keeps of an entry: its data and where and when it came from. */
type SavedEntry<T> = Pick<QueryEntry<T>, "data" | "history" | "source" | "asOf" | "delayMinutes">;

export class QueryStore<T> {
  private readonly entries = new Map<string, QueryEntry<T>>();
  /** Stored keys no pane is watching, least recently used first. */
  private readonly unwatched = new Set<string>();

  constructor(
    private readonly onChange: (key: string) => void,
    private readonly options: QueryStoreOptions<T> = {},
  ) {}

  get(key: string): QueryEntry<T> {
    const entry = this.entries.get(key);
    if (entry) return entry;
    const saved = this.readSaved(key);
    if (!saved) return createIdleEntry<T>();
    // Kept as the key's entry, without a change event: reading it is not news.
    return this.store(key, saved);
  }

  set(key: string, entry: QueryEntry<T>): void {
    this.save(key, this.store(key, entry));
    this.onChange(key);
  }

  update(key: string, updater: (current: QueryEntry<T>) => QueryEntry<T>): QueryEntry<T> {
    const next = this.store(key, updater(this.get(key)));
    this.save(key, next);
    this.onChange(key);
    return next;
  }

  private savedKey(key: string) {
    const saved = this.options.savedCopies!;
    return { key: [saved.name, key], version: saved.version };
  }

  private readSaved(key: string): QueryEntry<T> | null {
    if (!this.options.savedCopies) return null;
    const copy = readSavedCopy<SavedEntry<T>>(this.savedKey(key));
    if (!copy?.value || copy.value.data == null) return null;
    const { data, ...from } = copy.value;
    const value = this.options.savedCopies.mark?.(data, copy.fetchedAt) ?? data;
    return { ...createIdleEntry<T>(), ...from, phase: "ready", data: value, lastGoodData: value, fetchedAt: copy.fetchedAt, savedCopyAt: copy.fetchedAt, staleAt: 0 };
  }

  private save(key: string, entry: QueryEntry<T>): void {
    if (!this.options.savedCopies || entry.phase !== "ready" || entry.savedCopyAt != null || entry.error || entry.data == null) return;
    const { data, history, source, asOf, delayMinutes } = entry;
    writeSavedCopy(this.savedKey(key), { data, history, source, asOf, delayMinutes }, entry.fetchedAt ?? Date.now(), this.options.savedCopies.writeIntervalMs);
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
