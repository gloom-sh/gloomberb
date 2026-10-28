import type { AppResourceStorePort } from "../core/app-service-ports";
import type { JsonValue } from "../data/sqlite/json";
import type { PersistedResourceValue } from "../types/persistence";
import type { PluginPersistence } from "../types/plugin";

type SetResourceOptions = Parameters<PluginPersistence["setResource"]>[3];

/**
 * A plugin's persistence in a command: what the command fetches through a
 * plugin's cache is saved in the profile, under the namespace the app keeps
 * it in (`plugin:<state id>`), so a later run whose refresh fails answers
 * from that saved copy as the app does. Only a read that may take an expired
 * copy (`allowExpired`, what a cache falls back to when its refresh fails)
 * reaches the saved copies; any other read sees only what this run fetched,
 * so a command still asks for current data rather than answering from the
 * app's cache. Plugin state is not read or kept. With no resource store,
 * nothing outlives the run.
 */
export function createCommandPluginPersistence(resources: AppResourceStorePort | null | undefined, namespace: string): PluginPersistence {
  const fetched = new Map<string, PersistedResourceValue<unknown>>();
  const keyOf = (kind: string, key: string) => `${kind}:${key}`;
  return {
    getState: () => null,
    setState: () => {},
    deleteState: () => {},
    getResource: <T = unknown>(kind: string, key: string, options?: { sourceKey?: string; schemaVersion?: number; allowExpired?: boolean }) => {
      const own = fetched.get(keyOf(kind, key)) as PersistedResourceValue<T> | undefined;
      if (own || !options?.allowExpired || !resources) return own ?? null;
      const record = resources.get<T>(
        { namespace, kind, entityKey: key, sourceKey: options.sourceKey },
        { schemaVersion: options.schemaVersion, allowExpired: true },
      );
      return record && {
        value: record.value,
        fetchedAt: record.fetchedAt,
        staleAt: record.staleAt,
        expiresAt: record.expiresAt,
        sourceKey: record.sourceKey,
        schemaVersion: record.schemaVersion,
        provenance: record.provenance,
        stale: record.stale,
        expired: record.expired,
      };
    },
    setResource: <T = unknown>(kind: string, key: string, value: T, options: SetResourceOptions) => {
      const fetchedAt = Date.now();
      const entry: PersistedResourceValue<T> = {
        value,
        fetchedAt,
        staleAt: fetchedAt + options.cachePolicy.staleMs,
        expiresAt: fetchedAt + options.cachePolicy.expireMs,
        sourceKey: options.sourceKey ?? "",
        schemaVersion: options.schemaVersion ?? 1,
        provenance: options.provenance ?? null,
      };
      fetched.set(keyOf(kind, key), entry);
      resources?.set<T>({ namespace, kind, entityKey: key, sourceKey: options.sourceKey }, value, {
        cachePolicy: options.cachePolicy,
        schemaVersion: options.schemaVersion,
        provenance: options.provenance as JsonValue | null | undefined,
      });
      return entry;
    },
    deleteResource: (kind: string, key: string, options?: { sourceKey?: string }) => {
      fetched.delete(keyOf(kind, key));
      resources?.delete({ namespace, kind, entityKey: key, sourceKey: options?.sourceKey });
    },
  };
}
