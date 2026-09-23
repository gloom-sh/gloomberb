import type { QueryEntry } from "./result-types";
import { createIdleEntry } from "./result-types";

export class QueryStore<T> {
  private readonly entries = new Map<string, QueryEntry<T>>();

  /**
   * `project` sees every entry before it is stored, so a store can overlay a
   * newer source (a streamed FX rate over a loaded one) on whatever writes it.
   */
  constructor(
    private readonly onChange: (key: string) => void,
    private readonly project?: (key: string, entry: QueryEntry<T>) => QueryEntry<T>,
  ) {}

  get(key: string): QueryEntry<T> {
    return this.entries.get(key) ?? createIdleEntry<T>();
  }

  set(key: string, entry: QueryEntry<T>): void {
    this.entries.set(key, this.project ? this.project(key, entry) : entry);
    this.onChange(key);
  }

  update(key: string, updater: (current: QueryEntry<T>) => QueryEntry<T>): QueryEntry<T> {
    const updated = updater(this.get(key));
    const next = this.project ? this.project(key, updated) : updated;
    this.entries.set(key, next);
    this.onChange(key);
    return next;
  }
}
