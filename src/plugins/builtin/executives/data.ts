import {
  apiClient,
  type CloudProxyStatementListPayload,
  type CloudProxyStatementPayload,
} from "../../../api-client";
import { ApiRequestError, isPermanentClientError } from "../../../api-client/errors";
import type { PluginPersistence } from "../../../types/plugin";

/**
 * Executive compensation comes from Gloom Cloud's open proxy-statement
 * reads. A proxy is filed once a year and the extraction does not change
 * after it is verified, so a statement is kept for a long time; the list
 * of years is refreshed more often, since a new filing adds one.
 */

const LIST_KIND = "proxies";
const STATEMENT_KIND = "proxy";
const CACHE_SOURCE = "executives";
const CACHE_SCHEMA_VERSION = 1;

const LIST_CACHE_POLICY = {
  staleMs: 6 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const;

const STATEMENT_CACHE_POLICY = {
  staleMs: 7 * 24 * 60 * 60 * 1000,
  expireMs: 365 * 24 * 60 * 60 * 1000,
} as const;

interface ProxyResult<T> {
  /** Null is an explicit 404, not a transient failure or access denial. */
  data: T | null;
  fetchedAt: number | null;
  refreshError?: string;
}
type ActiveRequest<T> = { store: PluginPersistence | null; promise: Promise<ProxyResult<T>> };
let persistence: PluginPersistence | null = null;
const activeListFetches = new Map<string, ActiveRequest<CloudProxyStatementListPayload>>();
const activeStatementFetches = new Map<string, ActiveRequest<CloudProxyStatementPayload>>();
const failedRefreshes = new Set<string>();

export function attachExecutivesPersistence(value: PluginPersistence): void {
  if (persistence !== value) resetExecutivesPersistence();
  persistence = value;
}

export function resetExecutivesPersistence(): void {
  persistence = null;
  activeListFetches.clear();
  activeStatementFetches.clear();
  failedRefreshes.clear();
}

function loadCached<T>(
  kind: string,
  key: string,
  active: Map<string, ActiveRequest<T>>,
  policy: { staleMs: number; expireMs: number },
  force: boolean,
  fetch: () => Promise<T>,
): Promise<ProxyResult<T>> {
  const store = persistence;
  const options = { sourceKey: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION };
  const failedKey = `${kind}:${key}`;
  const hit = store?.getResource<T>(kind, key, options);
  if (!force && !failedRefreshes.has(failedKey) && hit && !hit.stale) {
    return Promise.resolve({ data: hit.value, fetchedAt: hit.fetchedAt });
  }
  const existing = active.get(key);
  if (!force && existing?.store === store) return existing.promise;
  const request: ActiveRequest<T> = { store, promise: null! };
  const current = () => persistence === store && active.get(key) === request;
  request.promise = Promise.resolve().then(fetch).then((data) => {
    const fetchedAt = Date.now();
    if (current()) {
      failedRefreshes.delete(failedKey);
      store?.setResource(kind, key, data, { ...options, cachePolicy: policy });
    }
    return { data, fetchedAt };
  }).catch((error: unknown) => {
    // A failed forced refresh must be retried on reopen even before the old TTL.
    if (current()) failedRefreshes.add(failedKey);
    // Removed or denied research must not be replaced by previously cached data.
    if (isPermanentClientError(error)) {
      if (current()) store?.deleteResource(kind, key, { sourceKey: CACHE_SOURCE });
      if (error instanceof ApiRequestError && error.status === 404) {
        return { data: null, fetchedAt: null };
      }
      throw error;
    }
    const fallback = store?.getResource<T>(kind, key, { ...options, allowExpired: true });
    if (!fallback) throw error;
    return {
      data: fallback.value,
      fetchedAt: fallback.fetchedAt,
      refreshError: (error instanceof Error ? error.message : String(error)).trim() || "Request failed",
    };
  }).finally(() => { if (active.get(key) === request) active.delete(key); });
  active.set(key, request);
  return request.promise;
}

export async function loadProxyStatements(
  ticker: string,
  options?: { force?: boolean },
): Promise<ProxyResult<CloudProxyStatementListPayload>> {
  const key = ticker.toUpperCase();
  return loadCached(LIST_KIND, key, activeListFetches, LIST_CACHE_POLICY, options?.force ?? false,
    () => apiClient.getProxyStatements(key));
}

export async function loadProxyStatement(
  ticker: string,
  year: number,
  options?: { force?: boolean },
): Promise<ProxyResult<CloudProxyStatementPayload>> {
  const key = `${ticker.toUpperCase()}:${year}`;
  return loadCached(STATEMENT_KIND, key, activeStatementFetches, STATEMENT_CACHE_POLICY, options?.force ?? false,
    () => apiClient.getProxyStatement(ticker.toUpperCase(), year));
}
