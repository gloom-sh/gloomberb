import { logFailure } from "../utils/log-failure";
import type { CachePolicy } from "../types/persistence";
import type { PluginPersistence } from "../types/plugin";
import { CachedQuery, type CachedValue } from "./cached-query";
import { isTransientFailure } from "../api-client/errors";

export interface PluginCacheResult<T> {
  data: T;
  fetchedAt: number;
  stale: boolean;
  refreshError?: string;
  error?: unknown;
  source: "cache" | "network" | "stale-fallback";
}

/**
 * `result`, or the failure of the refresh it stands in for when a saved copy
 * may not answer for it. A saved copy covers only a failure asking again may
 * get past (`isTransientFailure`: no connection, a timeout, a rate-limited or
 * overloaded server, a reply whose source did not answer this time); a
 * refusal (another 4xx, such as a series no longer served or a signed-out
 * session) and an answer that failed validation are thrown, so they show as
 * the errors they are instead of as old data.
 */
export function savedCopyForTransientFailure<R extends { source?: PluginCacheResult<unknown>["source"]; error?: unknown }>(result: R): R {
  if (result.source === "stale-fallback" && !isTransientFailure(result.error)) throw result.error;
  return result;
}

/** Shared persistence/request lifecycle; keys, codecs, validation and policies stay with the plugin. */
export function createPluginCache<T, Stored = T>(options: {
  kind: string;
  source: string;
  schemaVersion?: number;
  policy: CachePolicy;
  encode?: (value: T) => Stored;
  decode?: (value: Stored) => T;
}) {
  let persistence: PluginPersistence | null = null;
  let generation = 0;
  const queries = new Map<string, CachedQuery<T>>();
  const versions = new Map<string, number>();
  const read = (key: string, allowExpired = false): CachedValue<T> | null => {
    const record = persistence?.getResource<Stored>(options.kind, key, {
      sourceKey: options.source, schemaVersion: options.schemaVersion ?? 1, allowExpired,
    });
    if (!record) return null;
    let value: T;
    try { value = options.decode ? options.decode(record.value) : record.value as unknown as T; }
    catch (error) {
      logFailure("data.plugin-cache", "Decoding a cached resource failed")(error);
      return null;
    } // A corrupt cache entry must not prevent a fresh load.
    return {
      value,
      fetchedAt: record.fetchedAt,
      staleAt: record.stale ? Math.min(record.staleAt, Date.now() - 1) : record.staleAt,
      expiresAt: record.expiresAt,
      source: options.source,
    };
  };
  /**
   * Listeners by key, kept apart from the queries so they outlive a reset:
   * a pane that subscribed before the plugin attached its store still hears
   * the loads made after.
   */
  const listeners = new Map<string, Set<() => void>>();
  const emit = (key: string) => {
    for (const listener of [...listeners.get(key) ?? []]) listener();
  };
  const queryFor = (key: string): CachedQuery<T> => {
    let query = queries.get(key);
    if (!query) {
      query = new CachedQuery({ read: (allowExpired) => read(key, allowExpired) });
      query.subscribe(() => emit(key));
      queries.set(key, query);
    }
    return query;
  };
  const reset = () => {
    generation += 1;
    persistence = null;
    for (const query of queries.values()) query.dispose();
    queries.clear();
    versions.clear();
  };
  return {
    attach(next: PluginPersistence) {
      if (persistence === next) return;
      reset();
      persistence = next;
      // What a listener reads now comes from another store.
      for (const key of [...listeners.keys()]) emit(key);
    },
    reset,
    subscribe(key: string, listener: () => void): () => void {
      const keyed = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, keyed);
      keyed.add(listener);
      return () => {
        keyed.delete(listener);
        if (keyed.size === 0 && listeners.get(key) === keyed) listeners.delete(key);
      };
    },
    get(key: string, { allowExpired = false } = {}): PluginCacheResult<T> | null {
      const cached = read(key, allowExpired) ?? queries.get(key)?.getSnapshot().result;
      if (!cached || (!allowExpired && cached.expiresAt <= Date.now())) return null;
      return { data: cached.value, fetchedAt: cached.fetchedAt, stale: cached.staleAt <= Date.now(), source: "cache" };
    },
    async load(key: string, loader: () => Promise<T>, { force = false, replace = false } = {}): Promise<PluginCacheResult<T>> {
      const query = queryFor(key);
      const owner = generation;
      const before = query.getSnapshot().result;
      const result = await query.load({ force, replace, fetch: async () => {
        const version = (versions.get(key) ?? 0) + 1;
        versions.set(key, version);
        const value = await loader();
        const fetchedAt = Date.now();
        if (owner === generation && versions.get(key) === version) {
          persistence?.setResource(options.kind, key, options.encode ? options.encode(value) : value, {
            sourceKey: options.source, schemaVersion: options.schemaVersion ?? 1, cachePolicy: options.policy,
          });
        }
        return { value, fetchedAt, staleAt: fetchedAt + options.policy.staleMs, expiresAt: fetchedAt + options.policy.expireMs, source: options.source };
      } });
      // A retained copy carries its refresh failure, whatever was thrown (an Error without a message included).
      const failed = "refreshError" in result;
      const error = result.refreshError;
      return {
        data: result.value, fetchedAt: result.fetchedAt, stale: failed || result.staleAt <= Date.now(),
        source: failed ? "stale-fallback" : result === before ? "cache" : "network",
        ...(failed ? { error, refreshError: error instanceof Error ? error.message : String(error) } : {}),
      };
    },
  };
}
