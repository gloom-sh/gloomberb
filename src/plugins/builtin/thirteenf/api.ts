import type {
  ThirteenFEdgarFiling,
  ThirteenFFilerStatus,
  ThirteenFFormSummary,
  ThirteenFFund,
  ThirteenFHoldingRecord,
  ThirteenFTickerHolders,
  ThirteenFTickerInfo,
  ThirteenFTopFund,
} from "./types";
import type { PluginPersistence } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { ApiRequestError, isPermanentClientError, isTransientFailure } from "../../../api-client/errors";
import { httpFetch } from "../../../utils/http-transport";
import { asRecord, finiteOrNull } from "../../../utils/guards";
import { logFailure } from "../../../utils/log-failure";

const FORMS_13F_BASE_URL = "https://forms13f.com/api/v1";
const FORM_PAGE_LIMIT = 100;
// Large funds file well past 2,000 positions, and a silently clipped
// list makes every weight, total, and buy/sell action wrong. Paging further is
// slower but truthful; page in parallel if the wait becomes the problem.
const MAX_FORM_ROWS = 20_000;
const CACHE_KIND = "forms13f-api";
const CACHE_SOURCE = "forms13f";
const CACHE_SCHEMA_VERSION = 1;
const FORMS_13F_CACHE_POLICY = {
  staleMs: 24 * 60 * 60_000,
  expireMs: 30 * 24 * 60 * 60_000,
} as const;

export interface Forms13FReadOptions {
  /** A part of the answer that could not be read, said beside what was. */
  onWarning?: (warning: string) => void;
  /**
   * A read answered from the copy saved at `savedAt` (ms) because its refresh
   * failed. Only a caller that says when its copy was saved (the footer's
   * "saved copy from", a command's closing line) is answered from one.
   */
  onSavedCopy?: (savedAt: number) => void;
  forceRefresh?: boolean;
}

interface Forms13FRequestOptions extends Forms13FReadOptions {
  cache?: boolean;
  signal?: AbortSignal;
  /** Gloom Cloud only: a path the public 13F source does not serve. */
  cloudOnly?: boolean;
}

let forms13FPersistence: PluginPersistence | null = null;
const failedRefreshes = new Set<string>();
// The promise is the generation. A newer download replaces it, and the replaced one must not write.
const activeRequests = new Map<string, Promise<unknown>>();

export function attachThirteenFApiPersistence(persistence: PluginPersistence) {
  if (forms13FPersistence !== persistence) resetThirteenFApiPersistence();
  forms13FPersistence = persistence;
}

export function resetThirteenFApiPersistence() {
  forms13FPersistence = null;
  failedRefreshes.clear();
  activeRequests.clear();
}

function padCik(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits ? digits.padStart(10, "0").slice(-10) : value;
}

export function normalizeCik(value: string): string {
  return padCik(value.trim());
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolOrFalse(value: unknown): boolean {
  return value === true;
}

function arrayResponse(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeAccessionNumber(rawValue: unknown, rawUrl: unknown): string {
  const value = stringOrEmpty(rawValue);
  if (value.includes("-")) return value;
  const url = stringOrEmpty(rawUrl);
  const urlMatch = /(\d{10}-\d{2}-\d{6})\.txt\b/.exec(url);
  if (urlMatch) return urlMatch[1]!;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 18) {
    return `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
  }
  return value;
}

function cacheKey(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

async function fetchForms13F<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  options: Forms13FRequestOptions = {},
): Promise<T> {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    searchParams.set(key, String(value));
  }

  const key = cacheKey(path, searchParams);
  const store = forms13FPersistence;
  const cacheOptions = { sourceKey: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION };
  const cached = options.cache !== false ? store?.getResource<T>(CACHE_KIND, key, cacheOptions) ?? null : null;
  if (cached != null && !options.forceRefresh && !cached.stale && !failedRefreshes.has(key)) return cached.value;

  if (!options.forceRefresh) {
    const pending = activeRequests.get(key) as Promise<T> | undefined;
    if (pending) return cached != null ? cached.value : pending;
  }

  const slot: { promise?: Promise<T> } = {};
  const current = () => forms13FPersistence === store && activeRequests.get(key) === slot.promise;
  const promise = (async (): Promise<T> => {
    // Yield once so the caller can publish this promise before a synchronous abort settles it.
    await Promise.resolve();
    try {
      options.signal?.throwIfAborted();
      let value: T;
      try {
        value = await apiClient.getCloudSec13F(path, params, { signal: options.signal }) as T;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (options.cloudOnly) throw error;
        const url = `${FORMS_13F_BASE_URL}${path}?${searchParams.toString()}`;
        const response = await httpFetch(url, {
          headers: { Accept: "application/json" },
          signal: options.signal,
        });
        if (!response.ok) throw new ApiRequestError(`Forms13F ${response.status} for ${path}`, response.status);
        value = await response.json() as T;
      }
      options.signal?.throwIfAborted();
      if (current()) {
        failedRefreshes.delete(key);
        if (value != null && options.cache !== false) {
          store?.setResource(CACHE_KIND, key, value, { ...cacheOptions, cachePolicy: FORMS_13F_CACHE_POLICY });
        }
      }
      return value;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (current()) failedRefreshes.add(key);
      // A saved copy answers only for a failure asking again may get past; a refusal or a reply that
      // fails validation is the error, and a missing or denied resource also drops its copy.
      if (!isTransientFailure(error)) {
        if (isPermanentClientError(error) && current()) store?.deleteResource(CACHE_KIND, key, { sourceKey: CACHE_SOURCE });
        throw error;
      }
      const retained = options.cache !== false
        ? store?.getResource<T>(CACHE_KIND, key, { ...cacheOptions, allowExpired: true }) : null;
      // A caller may retain old research only when it can say when it was saved.
      if (!retained || !options.onSavedCopy || !Number.isFinite(retained.fetchedAt)) throw error;
      options.onSavedCopy(retained.fetchedAt);
      return retained.value;
    } finally {
      if (activeRequests.get(key) === slot.promise) activeRequests.delete(key);
    }
  })();
  slot.promise = promise;
  activeRequests.set(key, promise);
  if (cached != null && !options.forceRefresh) {
    void promise.catch((error: unknown) => {
      if (!options.signal?.aborted) logFailure("thirteenf.api", "Refresh cached filing data failed")(error);
    });
    return cached.value;
  }
  return promise;
}

function mapFund(raw: any): ThirteenFFund | null {
  const cik = normalizeCik(stringOrEmpty(raw.CIK ?? raw.cik));
  const name = stringOrEmpty(raw.name ?? raw.company_name ?? raw.company_names?.[0]).trim();
  if (!cik || !name) return null;
  return { cik, name };
}

export function mapForm(raw: any): ThirteenFFormSummary | null {
  const cik = normalizeCik(stringOrEmpty(raw.cik));
  const accessionNumber = normalizeAccessionNumber(raw.accession_number, raw.url);
  const periodOfReport = stringOrEmpty(raw.period_of_report);
  if (!cik || !accessionNumber || !periodOfReport) return null;
  const submissionType = stringOrEmpty(raw.submission_type || raw.form_type);
  return {
    url: stringOrEmpty(raw.url),
    accessionNumber,
    submissionType,
    periodOfReport,
    filedAsOfDate: stringOrEmpty(raw.filed_as_of_date),
    cik,
    companyName: stringOrEmpty(raw.company_name),
    tableValueTotal: finiteOrNull(raw.table_value_total),
    tableEntryTotal: finiteOrNull(raw.table_entry_total),
    isAmendment: boolOrFalse(raw.is_amendment) || submissionType.includes("/A"),
    amendmentType: stringOrEmpty(raw.amendment_type) || undefined,
    valueNote: stringOrEmpty(raw.value_note) || undefined,
  };
}

function mapHolding(raw: any): ThirteenFHoldingRecord | null {
  const accessionNumber = stringOrEmpty(raw.accession_number);
  const cik = normalizeCik(stringOrEmpty(raw.cik));
  const cusip = stringOrEmpty(raw.cusip);
  if (!accessionNumber || !cik || !cusip) return null;
  return {
    accessionNumber,
    cik,
    issuer: stringOrEmpty(raw.name_of_issuer),
    titleOfClass: stringOrEmpty(raw.title_of_class),
    cusip,
    ticker: stringOrEmpty(raw.ticker).toUpperCase(),
    value: finiteOrNull(raw.value),
    shares: finiteOrNull(raw.ssh_prnamt),
    shareType: stringOrEmpty(raw.ssh_prnamt_type),
    investmentDiscretion: stringOrEmpty(raw.investment_discretion),
    votingAuthoritySole: finiteOrNull(raw.voting_authority_sole),
    votingAuthorityShared: finiteOrNull(raw.voting_authority_shared),
    votingAuthorityNone: finiteOrNull(raw.voting_authority_none),
    putCall: stringOrEmpty(raw.put_call).toUpperCase(),
  };
}

function mapTopFund(raw: any): ThirteenFTopFund | null {
  const cik = normalizeCik(stringOrEmpty(raw.cik));
  const name = stringOrEmpty(raw.name).trim();
  const periodOfReport = stringOrEmpty(raw.period_of_report);
  if (!cik || !name || !periodOfReport) return null;
  return {
    cik,
    name,
    periodOfReport,
    pnl: finiteOrNull(raw.pnl),
  };
}

function mapTickerInfo(raw: any): ThirteenFTickerInfo | null {
  const cusip = stringOrEmpty(raw.cusip);
  const ticker = stringOrEmpty(raw.ticker).toUpperCase();
  if (!cusip || !ticker) return null;
  return {
    cusip,
    ticker,
    companyName: stringOrEmpty(raw.company_name),
  };
}

export async function searchThirteenFFunds(
  query: string,
  limit = 50,
  signal?: AbortSignal,
  options: Forms13FReadOptions & { offset?: number } = {},
): Promise<ThirteenFFund[]> {
  const raw = await fetchForms13F<unknown>("/funds", {
    name: query,
    offset: options.offset ?? 0,
    limit,
  }, { ...options, signal });
  return arrayResponse(raw).map(mapFund).filter((fund): fund is ThirteenFFund => !!fund);
}

/** The most funds one page of the performance ranking holds; the source refuses more. */
export const TOP_FUNDS_MAX_LIMIT = 100;

export async function listTopThirteenFFunds(
  quarter: string,
  limit = 50,
  signal?: AbortSignal,
  options: Forms13FReadOptions & { offset?: number } = {},
): Promise<ThirteenFTopFund[]> {
  const raw = await fetchForms13F<unknown>("/topfunds", {
    quarter,
    limit: Math.min(limit, TOP_FUNDS_MAX_LIMIT),
    offset: options.offset ?? 0,
  }, { ...options, signal });
  return arrayResponse(raw).map(mapTopFund).filter((fund): fund is ThirteenFTopFund => !!fund);
}

export async function listThirteenFFilings(
  from: string,
  to: string,
  limit = 100,
  signal?: AbortSignal,
  options: Forms13FReadOptions & { offset?: number } = {},
): Promise<ThirteenFFormSummary[]> {
  const raw = await fetchForms13F<unknown>("/filings", {
    from,
    to,
    limit,
    offset: options.offset ?? 0,
  }, { ...options, signal });
  return arrayResponse(raw).map(mapForm).filter((form): form is ThirteenFFormSummary => !!form);
}

export async function listThirteenFForms(
  cik: string,
  from: string,
  to: string,
  limit = 12,
  signal?: AbortSignal,
  options: Forms13FReadOptions & { offset?: number } = {},
): Promise<ThirteenFFormSummary[]> {
  const raw = await fetchForms13F<unknown>("/forms", {
    cik: normalizeCik(cik),
    from,
    to,
    limit,
    offset: options.offset ?? 0,
  }, { ...options, signal });
  return arrayResponse(raw).map(mapForm).filter((form): form is ThirteenFFormSummary => !!form);
}

export async function listThirteenFFormHoldingsPage(
  cik: string,
  accessionNumber: string,
  signal?: AbortSignal,
  options: Forms13FReadOptions & { offset?: number; limit?: number } = {},
): Promise<{ rows: ThirteenFHoldingRecord[]; hasMore: boolean }> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? FORM_PAGE_LIMIT);
  const raw = await fetchForms13F<unknown>("/form", {
    cik: normalizeCik(cik),
    accession_number: accessionNumber,
    limit,
    offset,
  }, { ...options, signal });
  const rows = arrayResponse(raw).map(mapHolding).filter((holding): holding is ThirteenFHoldingRecord => !!holding);
  return { rows, hasMore: rows.length >= limit && offset + rows.length < MAX_FORM_ROWS };
}

export async function listThirteenFFormHoldings(
  cik: string,
  accessionNumber: string,
  signal?: AbortSignal,
  options: Forms13FReadOptions = {},
): Promise<ThirteenFHoldingRecord[]> {
  const rows: ThirteenFHoldingRecord[] = [];
  for (let offset = 0; offset < MAX_FORM_ROWS; offset += FORM_PAGE_LIMIT) {
    signal?.throwIfAborted();
    const page = await listThirteenFFormHoldingsPage(cik, accessionNumber, signal, {
      ...options,
      offset,
      limit: FORM_PAGE_LIMIT,
    });
    rows.push(...page.rows);
    if (!page.hasMore) break;
  }
  return rows;
}

export async function lookupThirteenFTickers(
  tickers: string[],
  signal?: AbortSignal,
  options: Forms13FReadOptions = {},
): Promise<ThirteenFTickerInfo[]> {
  const cleanTickers = tickers
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean)
    .join(",");
  if (!cleanTickers) return [];
  const raw = await fetchForms13F<unknown>("/tickers", {
    cusips: "",
    tickers: cleanTickers,
  }, { ...options, signal });
  return arrayResponse(raw).map(mapTickerInfo).filter((ticker): ticker is ThirteenFTickerInfo => !!ticker);
}

export async function lookupThirteenFHoldersByCusip(
  cusip: string,
  periodOfReport: string,
  signal?: AbortSignal,
  options: Forms13FReadOptions = {},
): Promise<ThirteenFTickerHolders> {
  const raw = asRecord(await fetchForms13F<unknown>("/holders", {
    cusip,
    period_of_report: periodOfReport,
  }, { ...options, signal }));
  return {
    cusip: stringOrEmpty(raw.cusip) || cusip,
    periodOfReport: stringOrEmpty(raw.period_of_report) || periodOfReport,
    ciks: Array.isArray(raw.ciks)
      ? raw.ciks.map((cik: unknown) => normalizeCik(stringOrEmpty(cik))).filter(Boolean)
      : [],
  };
}

function mapEdgarFiling(raw: any): ThirteenFEdgarFiling | null {
  const form = stringOrEmpty(raw?.form), period = stringOrEmpty(raw?.period), filed = stringOrEmpty(raw?.filed);
  if (!form.startsWith("13F") || !period || !filed) return null;
  const managers = Array.isArray(raw.otherManagers) ? raw.otherManagers : null;
  return {
    form,
    period,
    filed,
    accession: stringOrEmpty(raw.accession),
    url: stringOrEmpty(raw.url),
    ...(managers ? {
      otherManagers: managers
        .map((manager: any) => ({
          cik: stringOrEmpty(manager?.cik) ? normalizeCik(stringOrEmpty(manager.cik)) : null,
          name: stringOrEmpty(manager?.name).trim(),
          fileNumber: stringOrEmpty(manager?.fileNumber) || null,
        }))
        .filter((manager: { name: string }) => manager.name),
    } : {}),
  };
}

/**
 * The fund's 13F filings as EDGAR lists them, 13F-NT notices included, from
 * Gloom Cloud. A notice names the managers that reported its holdings.
 */
export async function loadThirteenFFilerStatus(
  cik: string,
  signal?: AbortSignal,
  options: Forms13FReadOptions = {},
): Promise<ThirteenFFilerStatus> {
  const raw = asRecord(await fetchForms13F<unknown>("/filer", { cik: normalizeCik(cik) }, { ...options, signal, cloudOnly: true }));
  return {
    cik: normalizeCik(stringOrEmpty(raw.cik) || cik),
    name: stringOrEmpty(raw.name),
    source: stringOrEmpty(raw.source),
    filings: arrayResponse(raw.filings).map(mapEdgarFiling).filter((filing): filing is ThirteenFEdgarFiling => !!filing),
  };
}
