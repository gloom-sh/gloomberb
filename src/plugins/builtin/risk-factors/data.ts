import {
  apiClient,
  type CloudRiskReportListPayload,
  type CloudRiskReportPayload,
} from "../../../api-client";
import { ApiRequestError, isPermanentClientError, isTransientFailure } from "../../../api-client/errors";
import { listingAbroad, type IssuerListingParams } from "../../../api-client/paths";
import { markSavedCopy, servedFromSavedCopy } from "../../../data/saved-copies";
import type { HeadlessPaneApiClient, PluginPersistence } from "../../../types/plugin";
import { secListingKey } from "../../../utils/sec";

/** What the pane says for a ticker with no 10-K report. */
export const noRiskFactorsTitle = (ticker: string) => `No 10-K risk factors on file for ${ticker}.`;

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
  /** Its refresh failed and the copy saved at this time (ms) answered instead. */
  savedAt?: number;
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
    let saved: ReturnType<PluginPersistence["setResource"]> | undefined;
    if (current()) {
      failedRefreshes.delete(failedKey);
      saved = store?.setResource(kind, key, payload, { ...options, cachePolicy: policy });
    }
    // The saved copy's own time, so the reply and a later read of the copy agree to the millisecond.
    return { ...payload, fetchedAt: saved?.fetchedAt ?? Date.now(), stale: false };
  }).catch((error: unknown) => {
    // A failed forced refresh must be retried when this pane is reopened, even
    // when the previously cached value has not reached its ordinary TTL yet.
    if (current()) failedRefreshes.set(failedKey, store);
    // A saved copy answers only for a failure asking again may get past: a refusal or a reply that
    // fails validation is the error, and a missing or denied resource also drops its copy.
    if (!isTransientFailure(error)) {
      if (isPermanentClientError(error) && current()) store?.deleteResource(kind, key, { sourceKey: CACHE_SOURCE });
      throw error;
    }
    const fallback = store?.getResource<T>(kind, key, { ...options, allowExpired: true });
    if (!fallback) throw error;
    // A command that shows it ends with when the copy was saved, not with the failure.
    return servedFromSavedCopy({
      ...fallback.value,
      fetchedAt: fallback.fetchedAt,
      stale: true,
      savedAt: fallback.fetchedAt,
      refreshError: (error instanceof Error ? error.message : String(error)).trim() || "Request failed",
      errorStatus: error instanceof ApiRequestError ? error.status : undefined,
    }, fallback.fetchedAt);
  }).finally(() => { if (active.get(key) === request) active.delete(key); });
  active.set(key, request);
  return request.promise;
}

interface RiskLoadOptions {
  force?: boolean;
  /** The listing's venue and company, for a listing outside the US. */
  listing?: IssuerListingParams;
  displayScope?: string | null;
  exchange?: string;
}

function riskKey(symbol: string, options?: RiskLoadOptions, year?: number): string {
  if (options?.displayScope != null) {
    return JSON.stringify([options.displayScope, symbol, options.exchange, options.listing?.exchange, options.listing?.name, year]);
  }
  const listingKey = secListingKey(symbol, options?.listing?.exchange);
  return year === undefined ? listingKey : `${listingKey}:${year}`;
}

function savedRisk<T extends object>(kind: string, ticker: string, options: RiskLoadOptions, year?: number): (T & RiskFreshness) | null {
  if (options.displayScope == null) return null;
  const key = riskKey(ticker.trim().toUpperCase(), options, year);
  const cached = persistence?.getResource<T>(kind, key, { sourceKey: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, allowExpired: true });
  return cached ? markSavedCopy({ ...cached.value, fetchedAt: cached.fetchedAt, stale: false }, cached.fetchedAt) : null;
}

export const getSavedRiskReports = (ticker: string, options: RiskLoadOptions) => savedRisk<CloudRiskReportListPayload>(LIST_KIND, ticker, options);
export const getSavedRiskReport = (ticker: string, year: number, options: RiskLoadOptions) => savedRisk<CloudRiskReportPayload>(REPORT_KIND, ticker, options, year);

export function loadRiskReportsWithClient(client: RiskApiClient, ticker: string, options?: RiskLoadOptions): Promise<RiskReportsResult> {
  const symbol = ticker.trim().toUpperCase();
  const key = riskKey(symbol, options);
  return loadCached(client, LIST_KIND, key, activeListFetches, LIST_CACHE_POLICY, options?.force ?? false, async () => {
    let payload: CloudRiskReportListPayload;
    try {
      payload = await client.getRiskReports(symbol, options?.listing);
    } catch (error) {
      // The list answers 404 when no 10-K risk report is on file (20-F filers, funds).
      if (error instanceof ApiRequestError && error.status === 404) return { company: null, reports: [] };
      throw error;
    }
    if (!payload || !Array.isArray(payload.reports)) throw new Error(`Risk report list unavailable for ${symbol}.`);
    return payload;
  });
}

export function loadRiskReportWithClient(client: RiskApiClient, ticker: string, year: number, options?: RiskLoadOptions): Promise<RiskReportResult> {
  const symbol = ticker.trim().toUpperCase();
  const abroad = listingAbroad(symbol, options?.listing?.exchange) !== null;
  const key = riskKey(symbol, options, year);
  return loadCached(client, REPORT_KIND, key, activeReportFetches, REPORT_CACHE_POLICY, options?.force ?? false, async () => {
    const payload = await client.getRiskReport(symbol, year, options?.listing);
    // SEC rows spell share classes BRK-B; a BRK.B request is the same company.
    // A listing abroad reads its registrant's rows, filed under that
    // registrant's US ticker (Sanofi's SNY for SAN in Paris).
    const sameTicker = (value: string | undefined) => abroad || value?.toUpperCase().replace(/\./g, "-") === symbol.replace(/\./g, "-");
    if (!payload || !sameTicker(payload.ticker) || payload.reportYear !== year) {
      throw new Error(`Risk report response does not match ${symbol} ${year}.`);
    }
    return payload;
  });
}

export const loadRiskReports = (ticker: string, options?: RiskLoadOptions) => loadRiskReportsWithClient(apiClient, ticker, options);
export const loadRiskReport = (ticker: string, year: number, options?: RiskLoadOptions) => loadRiskReportWithClient(apiClient, ticker, year, options);
