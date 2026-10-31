import { logFailure } from "../../../utils/log-failure";
import { ApiRequestError } from "../../../api-client/errors";
import { savedCopyForTransientFailure, type PluginCacheResult } from "../../../data/plugin-cache";

interface CloudCache<T> {
  get(key: string, options?: { allowExpired?: boolean }): PluginCacheResult<T> | null;
  load(key: string, loader: () => Promise<T>, options?: { force?: boolean }): Promise<PluginCacheResult<T>>;
}

/** A cached server payload; `stale` and `refreshError` come only from a failed refresh. */
export interface CloudResource<T> {
  payload: T;
  stale: boolean;
  refreshError: string | null;
  /** When the copy shown was saved, when it is one because its refresh failed. */
  savedAt?: number;
}

/**
 * Seeds a pane's first paint while its mount load runs, so cache age is not
 * staleness here. A cached copy that no longer validates is not shown.
 */
export function cachedCloudResource<T>(
  cache: CloudCache<T>,
  key: string,
  validate: (payload: T) => T = (payload) => payload,
): CloudResource<T> | null {
  const cached = cache.get(key, { allowExpired: true });
  if (!cached) return null;
  try {
    return { payload: validate(cached.data), stale: false, refreshError: null };
  } catch (error) {
    return logFailure("shared.cloud-resource", "Validate cached cloud payload failed", null)(error);
  }
}

const isAbort = (error: unknown) => !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";

/**
 * Loads through the cache, falling back to the cached copy when a refresh
 * fails for a reason asking again may get past (`isTransientFailure`). A
 * refusal still throws: a refused session, so the pane shows its sign-in wall
 * instead of data the account can no longer see, any other permanent client
 * error (an unknown series, a route not served), and a reply that fails
 * validation.
 *
 * Callers of one key share the request in flight, which runs on the first
 * caller's `signal`. When that caller goes away (a tab left while it loads,
 * for one that reads the same data), the shared request aborts; a caller
 * whose own `signal` is still live asks again instead of showing that
 * cancellation as its failure.
 */
export async function loadCloudResource<T>(
  cache: CloudCache<T>,
  key: string,
  fetch: () => Promise<T>,
  { force = false, validate = (payload: T) => payload, signal }: { force?: boolean; validate?: (payload: T) => T; signal?: AbortSignal } = {},
): Promise<CloudResource<T>> {
  const cancelledByOther = (error: unknown) => !!signal && !signal.aborted && isAbort(error);
  let result = await cache.load(key, fetch, { force }).catch((error: unknown) => {
    if (cancelledByOther(error)) return null;
    throw error;
  });
  if (!result || cancelledByOther(result.error)) result = await cache.load(key, fetch, { force });
  const saved = savedCopyForTransientFailure(result).source === "stale-fallback";
  // A copy served because its refresh failed is one by where it came from, whatever the failure said (or did not).
  return {
    payload: validate(result.data), stale: result.stale, refreshError: result.refreshError ?? null,
    ...(saved ? { savedAt: result.fetchedAt } : {}),
  };
}

/**
 * Turns a route the server does not serve yet (404, or the given statuses)
 * into a message that says what is unavailable; other errors pass through.
 * The status stays, so a 404 is still a refusal no saved copy answers for and
 * a 503 still a failure one may.
 */
export function unavailableOnServer(error: unknown, message: string, statuses: readonly number[] = [404]): unknown {
  return error instanceof ApiRequestError && statuses.includes(error.status ?? 0)
    ? new ApiRequestError(message, error.status, error.retryAfterMs, error.code, error.details)
    : error;
}

/**
 * Reads ahead many items' payloads in batch requests (`read`, at most `max`
 * ids each, sent side by side) into the cache their own loads read under
 * `key`, skipping an item cached fresh unless `force`. Answers the ids stored, which a forced load can
 * take as fresh; an item the batch failed or left out stays for its own load
 * to ask, which says why. A batch route the server does not serve (404) is
 * not asked again in this session.
 */
export function createCloudBatchAhead<T>(
  cache: CloudCache<T>,
  options: {
    max: number;
    validate: (payload: T) => T;
    read: (ids: string[]) => Promise<Array<{ id: string; payload: T }>>;
  },
): (items: ReadonlyArray<{ id: string; key: string }>, force?: boolean) => Promise<Set<string>> {
  let missing = false;
  return async (items, force = false) => {
    const stored = new Set<string>();
    const keys = new Map<string, string>();
    for (const { id, key } of items) {
      const cached = cache.get(key);
      if (force || !cached || cached.stale) keys.set(id, key);
    }
    const ids = [...keys.keys()];
    if (missing || ids.length < 2) return stored;
    const chunks = Array.from({ length: Math.ceil(ids.length / options.max) }, (_, index) => ids.slice(index * options.max, (index + 1) * options.max));
    await Promise.all(chunks.map(async (chunk) => {
      const read = await options.read(chunk).catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 404) missing = true;
        else logFailure("shared.cloud-resource", "Read a batch of cloud payloads ahead failed")(error);
        return [];
      });
      await Promise.all(read.map(async ({ id, payload }) => {
        const key = keys.get(id);
        if (!key) return;
        try {
          const valid = options.validate(payload);
          await cache.load(key, async () => valid, { force: true });
          stored.add(id);
        } catch (error) {
          logFailure("shared.cloud-resource", "Store a batched cloud payload failed")(error);
        }
      }));
    }));
    return stored;
  };
}
