import {
  apiClient,
  type CloudRiskReportListPayload,
  type CloudRiskReportPayload,
} from "../../../api-client";
import type { PluginPersistence } from "../../../types/plugin";

/**
 * Risk factor reports come from Gloom Cloud's open reads. A report is built
 * once per 10-K and does not change, so it is kept a long time; the list of
 * years gains one a year.
 */

const LIST_KIND = "reports";
const REPORT_KIND = "report";
const CACHE_SOURCE = "risk-factors";
const CACHE_SCHEMA_VERSION = 1;

const LIST_CACHE_POLICY = {
  staleMs: 6 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const;
const REPORT_CACHE_POLICY = {
  staleMs: 7 * 24 * 60 * 60 * 1000,
  expireMs: 365 * 24 * 60 * 60 * 1000,
} as const;

let persistence: PluginPersistence | null = null;
const activeListFetches = new Map<
  string,
  Promise<CloudRiskReportListPayload>
>();
const activeReportFetches = new Map<string, Promise<CloudRiskReportPayload>>();

export function attachRiskFactorsPersistence(value: PluginPersistence): void {
  persistence = value;
}

export function resetRiskFactorsPersistence(): void {
  persistence = null;
  activeListFetches.clear();
  activeReportFetches.clear();
}

function cached<T>(kind: string, key: string, allowExpired = false) {
  return persistence?.getResource<T>(kind, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired,
  });
}

function remember<T>(
  kind: string,
  key: string,
  value: T,
  policy: { staleMs: number; expireMs: number },
) {
  persistence?.setResource(kind, key, value, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachePolicy: policy,
  });
}

export async function loadRiskReports(
  ticker: string,
  options?: { force?: boolean },
): Promise<CloudRiskReportListPayload> {
  const key = ticker.toUpperCase();
  const force = options?.force ?? false;
  const hit = cached<CloudRiskReportListPayload>(LIST_KIND, key);
  if (!force && hit && !hit.stale) return hit.value;
  const active = activeListFetches.get(key);
  if (active && !force) return active;
  const request = apiClient
    .getRiskReports(key)
    .then((payload) => {
      remember(LIST_KIND, key, payload, LIST_CACHE_POLICY);
      return payload;
    })
    .catch((error: unknown) => {
      const expired = cached<CloudRiskReportListPayload>(LIST_KIND, key, true);
      if (expired) return expired.value;
      throw error;
    })
    .finally(() => {
      if (activeListFetches.get(key) === request) activeListFetches.delete(key);
    });
  activeListFetches.set(key, request);
  return request;
}

export async function loadRiskReport(
  ticker: string,
  year: number,
  options?: { force?: boolean },
): Promise<CloudRiskReportPayload> {
  const key = `${ticker.toUpperCase()}:${year}`;
  const force = options?.force ?? false;
  const hit = cached<CloudRiskReportPayload>(REPORT_KIND, key);
  if (!force && hit && !hit.stale) return hit.value;
  const active = activeReportFetches.get(key);
  if (active && !force) return active;
  const request = apiClient
    .getRiskReport(ticker, year)
    .then((payload) => {
      remember(REPORT_KIND, key, payload, REPORT_CACHE_POLICY);
      return payload;
    })
    .catch((error: unknown) => {
      const expired = cached<CloudRiskReportPayload>(REPORT_KIND, key, true);
      if (expired) return expired.value;
      throw error;
    })
    .finally(() => {
      if (activeReportFetches.get(key) === request)
        activeReportFetches.delete(key);
    });
  activeReportFetches.set(key, request);
  return request;
}
