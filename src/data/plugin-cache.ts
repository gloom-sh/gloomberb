import type { CachePolicy } from "../types/persistence";
import type { PluginPersistence } from "../types/plugin";
import { CachedQuery, type CachedValue } from "./cached-query";

export interface PluginCacheResult<T> {
  data: T;
  fetchedAt: number;
  stale: boolean;
  refreshError?: string;
  error?: unknown;
  source: "cache" | "network" | "stale-fallback";
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
    catch { return null; } // A corrupt cache entry must not prevent a fresh load.
    return {
      value,
      fetchedAt: record.fetchedAt,
      staleAt: record.stale ? Math.min(record.staleAt, Date.now() - 1) : record.staleAt,
      expiresAt: record.expiresAt,
      source: options.source,
    };
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
      if (persistence !== next) reset();
      persistence = next;
    },
    reset,
    get(key: string, { allowExpired = false } = {}): PluginCacheResult<T> | null {
      const cached = read(key, allowExpired) ?? queries.get(key)?.getSnapshot().result;
      if (!cached || (!allowExpired && cached.expiresAt <= Date.now())) return null;
      return { data: cached.value, fetchedAt: cached.fetchedAt, stale: cached.staleAt <= Date.now(), source: "cache" };
    },
    async load(key: string, loader: () => Promise<T>, { force = false, replace = false } = {}): Promise<PluginCacheResult<T>> {
      let query = queries.get(key);
      if (!query) {
        query = new CachedQuery({ read: (allowExpired) => read(key, allowExpired) });
        queries.set(key, query);
      }
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
      const error = result.refreshError;
      return {
        data: result.value, fetchedAt: result.fetchedAt, stale: !!error || result.staleAt <= Date.now(),
        source: error ? "stale-fallback" : result === before ? "cache" : "network",
        ...(error ? { error, refreshError: error instanceof Error ? error.message : String(error) } : {}),
      };
    },
  };
}
