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
 *   two callers never start two requests for one key. A load is shared for
 *   no longer than `ttlMs` (a number), so one that hangs cannot hold the key.
 * - `force` skips a fresh value and starts a load, except that it joins one
 *   that is already out when that load began after the value it would
 *   replace: panes that refresh together make one request, not one each.
 * - The last good value stays until a load brings a newer one. A forced
 *   load that fails, or brings a value `keep` refuses, leaves it in place,
 *   and `peek(key, { stale: true })` reads it past its TTL while a reload is
 *   out, for a view that keeps drawing the last copy.
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
  /** The oldest keys go first past this many. Default: unbounded. */
  maxEntries?: number;
  /** The clock, for tests. */
  now?: () => number;
}

export interface TtlCache<V> {
  /** The key's fresh value or the load already out for it; otherwise starts `load`. */
  load(key: string, load: () => V | PromiseLike<V>, options?: { force?: boolean }): Promise<V>;
  /**
   * The key's fresh value, `undefined` when it has none. `stale` also reads
   * the last good value past its TTL, for a view that keeps drawing it until
   * the next load lands.
   */
  peek(key: string, options?: { stale?: boolean }): V | undefined;
  /** Whether the key's last load was rejected and `rejectionMs` still keeps that rejection. */
  failed(key: string): boolean;
  /** Keeps a value that arrived by another road, for the TTL. */
  set(key: string, value: V): void;
  /**
   * Forgets the key. With `only`, a promise `load` returned, forgets just the
   * load or kept rejection it stands for, and only while it is still the
   * key's: a caller that gives up on a load cannot drop a newer one.
   */
  delete(key: string, only?: Promise<V>): void;
  clear(): void;
}

interface Slot<V> {
  /** The last good value: fresh until `expiresAt`, readable as stale after. */
  held?: { value: V; arrivedAt: number; expiresAt: number };
  /** The load that is out. */
  loading?: { promise: Promise<V>; startedAt: number };
  /** A rejected load kept for `rejectionMs`. */
  failed?: { promise: Promise<V>; expiresAt: number };
}

export function createTtlCache<V>(options: TtlCacheOptions<V>): TtlCache<V> {
  const { keep = () => true, rejectionMs = 0, maxEntries = Infinity, now: clock = () => Date.now() } = options;
  const ttlFor = (value: V) => typeof options.ttlMs === "function" ? options.ttlMs(value) : options.ttlMs;
  const shareMs = typeof options.ttlMs === "number" ? options.ttlMs : Infinity;
  const slots = new Map<string, Slot<V>>();

  const store = (key: string, slot: Slot<V>) => {
    slots.delete(key);
    slots.set(key, slot);
    while (slots.size > maxEntries) slots.delete(slots.keys().next().value!);
  };
  /** A slot with nothing in it is not kept. */
  const tidy = (key: string, slot: Slot<V>) => {
    if (!slot.held && !slot.loading && !slot.failed && slots.get(key) === slot) slots.delete(key);
  };
  const hold = (slot: Slot<V>, value: V) => {
    const arrivedAt = clock();
    slot.held = { value, arrivedAt, expiresAt: arrivedAt + ttlFor(value) };
    slot.failed = undefined;
  };

  return {
    load(key, load, { force = false } = {}) {
      const at = clock();
      const slot = slots.get(key) ?? {};
      const { held, loading, failed } = slot;
      if (!force) {
        if (held && held.expiresAt > at) return Promise.resolve(held.value);
        if (failed && failed.expiresAt > at) return failed.promise;
      }
      if (loading && at - loading.startedAt < shareMs && (!force || !held || loading.startedAt >= held.arrivedAt)) return loading.promise;

      const run: NonNullable<Slot<V>["loading"]> = { promise: undefined as unknown as Promise<V>, startedAt: at };
      const current = () => slots.get(key)?.loading === run;
      run.promise = new Promise<V>((resolve) => resolve(load())).then((value) => {
        if (current()) {
          slot.loading = undefined;
          try {
            // A `keep` or TTL function that throws rejects for the callers, like the load.
            if (keep(value)) hold(slot, value);
          } finally {
            tidy(key, slot);
          }
        }
        return value;
      }, (error: unknown) => {
        if (current()) {
          slot.loading = undefined;
          const fresh = slot.held && slot.held.expiresAt > clock();
          if (rejectionMs > 0 && !fresh) slot.failed = { promise: run.promise, expiresAt: clock() + rejectionMs };
          tidy(key, slot);
        }
        throw error;
      });
      // A caller that drops the promise must not raise an unhandled rejection.
      run.promise.then(undefined, () => { /* Intentional ignore: every caller holds this promise and sees the rejection. */ });
      slot.loading = run;
      slot.failed = undefined;
      store(key, slot);
      return run.promise;
    },
    peek(key, { stale = false } = {}) {
      const held = slots.get(key)?.held;
      return held && (stale || held.expiresAt > clock()) ? held.value : undefined;
    },
    failed(key) {
      const failed = slots.get(key)?.failed;
      return !!failed && failed.expiresAt > clock();
    },
    set(key, value) {
      if (!keep(value)) return;
      const slot = slots.get(key) ?? {};
      hold(slot, value);
      store(key, slot);
    },
    delete(key, only) {
      const slot = slots.get(key);
      if (!slot) return;
      if (!only) {
        slots.delete(key);
        return;
      }
      if (slot.loading?.promise === only) slot.loading = undefined;
      if (slot.failed?.promise === only) slot.failed = undefined;
      tidy(key, slot);
    },
    clear() {
      slots.clear();
    },
  };
}
