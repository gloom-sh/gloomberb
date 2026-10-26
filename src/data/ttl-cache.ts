/**
 * A keyed in-memory cache that serves a loaded value for a while and shares a
 * load that is still out. It is what a plugin reaches for instead of keeping
 * its own `Map<key, { at, value }>` with a TTL constant and `Date.now() - at`
 * checks, each copy with its own rule for a concurrent call, a forced reload
 * and a failed load.
 *
 * It holds nothing across a restart, and `load` never answers with an expired
 * value. A pane whose data must outlive a restart, or fall back to the saved
 * copy when a refresh fails, wants `createPluginCache` (src/data/plugin-cache.ts).
 *
 * The rules, for every key:
 * - A fresh value is served as it is; a load that is still out is shared, so
 *   two callers never start two requests for one key.
 * - `force` always starts a new load and replaces whatever the key held. A
 *   slower load it replaced still answers its own callers but is never kept.
 * - A load that rejects reaches every caller waiting on it. By default
 *   nothing is kept, so the next call asks again; `rejectionMs` keeps the
 *   rejection that long, for a load a poll would otherwise repeat each tick.
 * - A load runs as soon as `load` is called, not on a later tick.
 */
export interface TtlCacheOptions<V> {
  /** How long a loaded value is served, from when it arrives; a function sets it per value. */
  ttlMs: number | ((value: V) => number);
  /**
   * Whether a loaded value is kept. One that is not still answers the callers
   * waiting on it, and the next call loads again. Default: every value.
   */
  keep?: (value: V) => boolean;
  /** How long a rejected load is kept and served again. Default 0: it is dropped. */
  rejectionMs?: number;
  /** The oldest entries go first past this many. Default: unbounded. */
  maxEntries?: number;
  /** The clock; a call can pass its own `now` instead. */
  now?: () => number;
}

export interface TtlCache<V> {
  /** The key's fresh value or the load already out for it; otherwise starts `load`. */
  load(key: string, load: () => V | PromiseLike<V>, options?: { force?: boolean; now?: number }): Promise<V>;
  /**
   * The key's fresh value, `undefined` when it has none or its load is still
   * out. `stale` also reads a value past its TTL, for a view that keeps
   * drawing the last copy until the next load lands.
   */
  peek(key: string, options?: { stale?: boolean }): V | undefined;
  /** Keeps a value that arrived by another road, for the TTL. */
  set(key: string, value: V): void;
  delete(key: string): void;
  clear(): void;
}

interface Entry<V> {
  promise: Promise<V>;
  /** Present once the load has settled with a value. */
  held?: { value: V };
  /** Infinity while the load is out, so it is shared however long it takes. */
  expiresAt: number;
}

export function createTtlCache<V>(options: TtlCacheOptions<V>): TtlCache<V> {
  const { keep = () => true, rejectionMs = 0, maxEntries = Infinity, now: clock = () => Date.now() } = options;
  const ttlFor = (value: V) => typeof options.ttlMs === "function" ? options.ttlMs(value) : options.ttlMs;
  const entries = new Map<string, Entry<V>>();

  const store = (key: string, entry: Entry<V>) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
  };

  return {
    load(key, load, { force = false, now } = {}) {
      const known = entries.get(key);
      if (!force && known && known.expiresAt > (now ?? clock())) return known.promise;
      const entry: Entry<V> = { promise: new Promise<V>((resolve) => resolve(load())), expiresAt: Infinity };
      store(key, entry);
      // Both handlers settle the entry, so a caller that drops the promise never raises an unhandled rejection.
      entry.promise.then((value) => {
        if (entries.get(key) !== entry) return;
        if (!keep(value)) entries.delete(key);
        else {
          entry.held = { value };
          entry.expiresAt = (now ?? clock()) + ttlFor(value);
        }
      }, () => {
        if (entries.get(key) !== entry) return;
        if (rejectionMs > 0) entry.expiresAt = (now ?? clock()) + rejectionMs;
        else entries.delete(key);
      });
      return entry.promise;
    },
    peek(key, { stale = false } = {}) {
      const entry = entries.get(key);
      return entry?.held && (stale || entry.expiresAt > clock()) ? entry.held.value : undefined;
    },
    set(key, value) {
      if (!keep(value)) return;
      store(key, { promise: Promise.resolve(value), held: { value }, expiresAt: clock() + ttlFor(value) });
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
