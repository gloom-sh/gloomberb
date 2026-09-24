import {
  apiClient,
  type CloudRiskReportListPayload,
  type CloudRiskReportPayload,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { HeadlessPaneApiClient, PluginPersistence } from "../../../types/plugin";

/** Annual reports are immutable; discovery of newly produced reports is not. */
const LIST_KIND = "reports";
const REPORT_KIND = "report";
const CACHE_SOURCE = "risk-factors";
const CACHE_SCHEMA_VERSION = 1;
const LIST_CACHE_POLICY = { staleMs: 6 * 60 * 60 * 1000, expireMs: 30 * 24 * 60 * 60 * 1000 };
const REPORT_CACHE_POLICY = { staleMs: 7 * 24 * 60 * 60 * 1000, expireMs: 365 * 24 * 60 * 60 * 1000 };

type RiskApiClient = Pick<HeadlessPaneApiClient, "getRiskReports" | "getRiskReport">;
interface RiskFreshness {
  fetchedAt: number;
  stale: boolean;
  refreshError?: string;
  errorStatus?: number;
}
export type RiskReportsResult = CloudRiskReportListPayload & RiskFreshness;
export type RiskReportResult = CloudRiskReportPayload & RiskFreshness;
type ActiveRequest<T> = { client: RiskApiClient; store: PluginPersistence | null; promise: Promise<T & RiskFreshness> };
let persistence: PluginPersistence | null = null;
const activeListFetches = new Map<string, ActiveRequest<CloudRiskReportListPayload>>();
const activeReportFetches = new Map<string, ActiveRequest<CloudRiskReportPayload>>();
const failedRefreshes = new Map<string, PluginPersistence | null>();

export function attachRiskFactorsPersistence(value: PluginPersistence): void { persistence = value; }
export function resetRiskFactorsPersistence(): void {
  persistence = null;
  activeListFetches.clear();
  activeReportFetches.clear();
  failedRefreshes.clear();
}

/** A missing/denied resource must not be replaced by previously cached content. */
export function discardRiskData(error: unknown): boolean {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function loadCached<T extends object>(
  client: RiskApiClient,
  kind: string,
  key: string,
  active: Map<string, ActiveRequest<T>>,
  policy: { staleMs: number; expireMs: number },
  force: boolean,
  fetch: () => Promise<T>,
): Promise<T & RiskFreshness> {
  const store = persistence;
  const options = { sourceKey: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION };
  const failedKey = `${kind}:${key}`;
  const failed = failedRefreshes.has(failedKey) && failedRefreshes.get(failedKey) === store;
  const cached = store?.getResource<T>(kind, key, options);
  if (!force && !failed && cached && !cached.stale) {
    return Promise.resolve({ ...cached.value, fetchedAt: cached.fetchedAt, stale: false });
  }
  const existing = active.get(key);
  if (!force && existing?.client === client && existing.store === store) return existing.promise;
  const request: ActiveRequest<T> = { client, store, promise: null! };
  const current = () => active.get(key) === request && persistence === store;
  request.promise = Promise.resolve().then(fetch).then((payload) => {
    const fetchedAt = Date.now();
    if (current()) {
      failedRefreshes.delete(failedKey);
      store?.setResource(kind, key, payload, { ...options, cachePolicy: policy });
    }
    return { ...payload, fetchedAt, stale: false };
  }).catch((error: unknown) => {
    // A failed forced refresh must be retried when this pane is reopened, even
    // when the previously cached value has not reached its ordinary TTL yet.
    if (current()) failedRefreshes.set(failedKey, store);
    if (discardRiskData(error)) {
      if (current()) store?.deleteResource(kind, key, { sourceKey: CACHE_SOURCE });
      throw error;
    }
    const fallback = store?.getResource<T>(kind, key, { ...options, allowExpired: true });
    if (!fallback) throw error;
    return {
      ...fallback.value,
      fetchedAt: fallback.fetchedAt,
      stale: true,
      refreshError: (error instanceof Error ? error.message : String(error)).trim() || "Request failed",
      errorStatus: error instanceof ApiRequestError ? error.status : undefined,
    };
  }).finally(() => { if (active.get(key) === request) active.delete(key); });
  active.set(key, request);
  return request.promise;
}

export function loadRiskReportsWithClient(client: RiskApiClient, ticker: string, options?: { force?: boolean }): Promise<RiskReportsResult> {
  const key = ticker.trim().toUpperCase();
  return loadCached(client, LIST_KIND, key, activeListFetches, LIST_CACHE_POLICY, options?.force ?? false, async () => {
    let payload: CloudRiskReportListPayload;
    try {
      payload = await client.getRiskReports(key);
    } catch (error) {
      // The list answers 404 when no 10-K risk report is on file (20-F filers, funds).
      if (error instanceof ApiRequestError && error.status === 404) return { company: null, reports: [] };
      throw error;
    }
    if (!payload || !Array.isArray(payload.reports)) throw new Error(`Risk report list unavailable for ${key}.`);
    return payload;
  });
}

export function loadRiskReportWithClient(client: RiskApiClient, ticker: string, year: number, options?: { force?: boolean }): Promise<RiskReportResult> {
  const symbol = ticker.trim().toUpperCase();
  return loadCached(client, REPORT_KIND, `${symbol}:${year}`, activeReportFetches, REPORT_CACHE_POLICY, options?.force ?? false, async () => {
    const payload = await client.getRiskReport(symbol, year);
    // SEC rows spell share classes BRK-B; a BRK.B request is the same company.
    const sameTicker = (value: string | undefined) => value?.toUpperCase().replace(/\./g, "-") === symbol.replace(/\./g, "-");
    if (!payload || !sameTicker(payload.ticker) || payload.reportYear !== year) {
      throw new Error(`Risk report response does not match ${symbol} ${year}.`);
    }
    return payload;
  });
}

export const loadRiskReports = (ticker: string, options?: { force?: boolean }) => loadRiskReportsWithClient(apiClient, ticker, options);
export const loadRiskReport = (ticker: string, year: number, options?: { force?: boolean }) => loadRiskReportWithClient(apiClient, ticker, year, options);
