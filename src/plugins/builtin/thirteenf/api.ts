import type {
  ThirteenFFormSummary,
  ThirteenFFund,
  ThirteenFHoldingRecord,
  ThirteenFTickerHolders,
  ThirteenFTickerInfo,
  ThirteenFTopFund,
} from "./types";
import type { PluginPersistence } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { httpFetch } from "../../../utils/http-transport";

const FORMS_13F_BASE_URL = "https://forms13f.com/api/v1";
const FORM_PAGE_LIMIT = 100;
// ponytail: large funds file well past 2,000 positions, and a silently clipped
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

interface Forms13FRequestOptions {
  cache?: boolean;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

let forms13FPersistence: PluginPersistence | null = null;

export function attachThirteenFApiPersistence(persistence: PluginPersistence) {
  forms13FPersistence = persistence;
}

export function resetThirteenFApiPersistence() {
  forms13FPersistence = null;
}

function padCik(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits ? digits.padStart(10, "0").slice(-10) : value;
}

export function normalizeCik(value: string): string {
  return padCik(value.trim());
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function objectResponse(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function readApiCache<T>(
  key: string,
  options: { allowExpired?: boolean } = {},
): T | null {
  return forms13FPersistence?.getResource<T>(CACHE_KIND, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired: options.allowExpired,
  })?.value ?? null;
}

function writeApiCache<T>(key: string, value: T): void {
  forms13FPersistence?.setResource(CACHE_KIND, key, value, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachePolicy: FORMS_13F_CACHE_POLICY,
  });
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
  if (options.cache !== false && !options.forceRefresh) {
    const cached = readApiCache<T>(key);
    if (cached) return cached;
  }

  let value: T;
  try {
    value = await apiClient.getCloudSec13F(path, params) as T;
  } catch {
    const url = `${FORMS_13F_BASE_URL}${path}?${searchParams.toString()}`;
    const response = await httpFetch(url, {
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
    if (!response.ok) {
      const stale = options.cache !== false ? readApiCache<T>(key, { allowExpired: true }) : null;
      if (stale) return stale;
      throw new Error(`Forms13F ${response.status} for ${path}`);
    }
    value = await response.json() as T;
  }
  if (value != null && options.cache !== false) {
    writeApiCache(key, value);
  }
  return value;
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
  return {
    url: stringOrEmpty(raw.url),
    accessionNumber,
    submissionType: stringOrEmpty(raw.submission_type || raw.form_type),
    periodOfReport,
    filedAsOfDate: stringOrEmpty(raw.filed_as_of_date),
    cik,
    companyName: stringOrEmpty(raw.company_name),
    tableValueTotal: numberOrNull(raw.table_value_total),
    tableEntryTotal: numberOrNull(raw.table_entry_total),
    isAmendment: boolOrFalse(raw.is_amendment) || stringOrEmpty(raw.submission_type).includes("/A"),
    amendmentType: stringOrEmpty(raw.amendment_type) || undefined,
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
    value: numberOrNull(raw.value),
    shares: numberOrNull(raw.ssh_prnamt),
    shareType: stringOrEmpty(raw.ssh_prnamt_type),
    investmentDiscretion: stringOrEmpty(raw.investment_discretion),
    votingAuthoritySole: numberOrNull(raw.voting_authority_sole),
    votingAuthorityShared: numberOrNull(raw.voting_authority_shared),
    votingAuthorityNone: numberOrNull(raw.voting_authority_none),
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
    pnl: numberOrNull(raw.pnl),
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
  options: { forceRefresh?: boolean; offset?: number } = {},
): Promise<ThirteenFFund[]> {
  const raw = await fetchForms13F<unknown>("/funds", {
    name: query,
    offset: options.offset ?? 0,
    limit,
  }, { signal, forceRefresh: options.forceRefresh });
  return arrayResponse(raw).map(mapFund).filter((fund): fund is ThirteenFFund => !!fund);
}

export async function listTopThirteenFFunds(
  quarter: string,
  limit = 50,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; offset?: number } = {},
): Promise<ThirteenFTopFund[]> {
  const raw = await fetchForms13F<unknown>("/topfunds", {
    quarter,
    limit,
    offset: options.offset ?? 0,
  }, { signal, forceRefresh: options.forceRefresh });
  return arrayResponse(raw).map(mapTopFund).filter((fund): fund is ThirteenFTopFund => !!fund);
}

export async function listThirteenFFilings(
  from: string,
  to: string,
  limit = 100,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; offset?: number } = {},
): Promise<ThirteenFFormSummary[]> {
  const raw = await fetchForms13F<unknown>("/filings", {
    from,
    to,
    limit,
    offset: options.offset ?? 0,
  }, { signal, forceRefresh: options.forceRefresh });
  return arrayResponse(raw).map(mapForm).filter((form): form is ThirteenFFormSummary => !!form);
}

export async function listThirteenFForms(
  cik: string,
  from: string,
  to: string,
  limit = 12,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; offset?: number } = {},
): Promise<ThirteenFFormSummary[]> {
  const raw = await fetchForms13F<unknown>("/forms", {
    cik: normalizeCik(cik),
    from,
    to,
    limit,
    offset: options.offset ?? 0,
  }, { signal, forceRefresh: options.forceRefresh });
  return arrayResponse(raw).map(mapForm).filter((form): form is ThirteenFFormSummary => !!form);
}

export async function listThirteenFFormHoldingsPage(
  cik: string,
  accessionNumber: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; offset?: number; limit?: number } = {},
): Promise<{ rows: ThirteenFHoldingRecord[]; hasMore: boolean }> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? FORM_PAGE_LIMIT);
  const raw = await fetchForms13F<unknown>("/form", {
    cik: normalizeCik(cik),
    accession_number: accessionNumber,
    limit,
    offset,
  }, { signal, forceRefresh: options.forceRefresh });
  const rows = arrayResponse(raw).map(mapHolding).filter((holding): holding is ThirteenFHoldingRecord => !!holding);
  return { rows, hasMore: rows.length >= limit && offset + rows.length < MAX_FORM_ROWS };
}

export async function listThirteenFFormHoldings(
  cik: string,
  accessionNumber: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean } = {},
): Promise<ThirteenFHoldingRecord[]> {
  const rows: ThirteenFHoldingRecord[] = [];
  for (let offset = 0; offset < MAX_FORM_ROWS; offset += FORM_PAGE_LIMIT) {
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
  options: { forceRefresh?: boolean } = {},
): Promise<ThirteenFTickerInfo[]> {
  const cleanTickers = tickers
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean)
    .join(",");
  if (!cleanTickers) return [];
  const raw = await fetchForms13F<unknown>("/tickers", {
    cusips: "",
    tickers: cleanTickers,
  }, { signal, forceRefresh: options.forceRefresh });
  return arrayResponse(raw).map(mapTickerInfo).filter((ticker): ticker is ThirteenFTickerInfo => !!ticker);
}

export async function lookupThirteenFHoldersByCusip(
  cusip: string,
  periodOfReport: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean } = {},
): Promise<ThirteenFTickerHolders> {
  const raw = objectResponse(await fetchForms13F<unknown>("/holders", {
    cusip,
    period_of_report: periodOfReport,
  }, { signal, forceRefresh: options.forceRefresh }));
  return {
    cusip: stringOrEmpty(raw.cusip) || cusip,
    periodOfReport: stringOrEmpty(raw.period_of_report) || periodOfReport,
    ciks: Array.isArray(raw.ciks)
      ? raw.ciks.map((cik: unknown) => normalizeCik(stringOrEmpty(cik))).filter(Boolean)
      : [],
  };
}

export async function loadLatestFormsForFunds(
  funds: ThirteenFFund[],
  options: { from: string; to: string; signal?: AbortSignal; concurrency?: number; forceRefresh?: boolean },
): Promise<Map<string, ThirteenFFormSummary>> {
  const forms = new Map<string, ThirteenFFormSummary>();
  const concurrency = options.concurrency ?? 6;
  let index = 0;

  async function worker() {
    while (index < funds.length) {
      const fund = funds[index++];
      if (!fund) continue;
      try {
        const fundForms = await listThirteenFForms(fund.cik, options.from, options.to, 1, options.signal, {
          forceRefresh: options.forceRefresh,
        });
        const latest = fundForms[0];
        if (latest) forms.set(fund.cik, latest);
      } catch {
        // A missing form should not hide the fund row.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, funds.length) }, () => worker()));
  return forms;
}
