import { ApiRequestError, isAccessDenied } from "../../../api-client/errors";
import type { PluginCacheResult } from "../../../data/plugin-cache";

interface CloudCache<T> {
  get(key: string, options?: { allowExpired?: boolean }): PluginCacheResult<T> | null;
  load(key: string, loader: () => Promise<T>, options?: { force?: boolean }): Promise<PluginCacheResult<T>>;
}

/** A cached server payload; `stale` and `refreshError` come only from a failed refresh. */
export interface CloudResource<T> {
  payload: T;
  stale: boolean;
  refreshError: string | null;
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
  } catch {
    return null;
  }
}

/**
 * Loads through the cache, falling back to the cached copy when a refresh
 * fails. A refused session still throws, so the pane shows its sign-in wall
 * instead of data the account can no longer see.
 */
export async function loadCloudResource<T>(
  cache: CloudCache<T>,
  key: string,
  fetch: () => Promise<T>,
  { force = false, validate = (payload: T) => payload }: { force?: boolean; validate?: (payload: T) => T } = {},
): Promise<CloudResource<T>> {
  const result = await cache.load(key, fetch, { force });
  if (isAccessDenied(result.error)) throw result.error;
  return { payload: validate(result.data), stale: result.stale, refreshError: result.refreshError ?? null };
}

/**
 * Turns a route the server does not serve yet (404, or the given statuses)
 * into a message that says what is unavailable; other errors pass through.
 */
export function unavailableOnServer(error: unknown, message: string, statuses: readonly number[] = [404]): unknown {
  return error instanceof ApiRequestError && statuses.includes(error.status ?? 0) ? new Error(message) : error;
}
