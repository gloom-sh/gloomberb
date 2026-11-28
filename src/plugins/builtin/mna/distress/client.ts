import { apiClient, type CloudFilingEventPayload } from "../../../../api-client";
import type {
  DistressAttribution,
  DistressDesignation,
  DistressDesignationsParams,
  DistressDesignationsPayload,
  DistressFilingKind,
  DistressFilingsPayload,
  GoingConcernDisclosure,
  GoingConcernParams,
  GoingConcernPayload,
  InsolvencyNotice,
  InsolvencyNoticesParams,
  InsolvencyNoticesPayload,
} from "../../../../api-client/distress";
import { createPluginCache } from "../../../../data/plugin-cache";
import type { HeadlessPaneApiClient } from "../../../../types/plugin";
import { isCalendarDay, isHttpUrl, isIsoInstant, isNonEmptyText, isNonNegativeInt, isNullableCalendarDay, isNullableIsoInstant, isNullableString, isRecord, isStringArray } from "../../../../utils/guards";
import { unavailableOnServer } from "../../shared/cloud-resource";

/**
 * The parsers check every field the tab draws or links, so a changed or broken
 * answer becomes an error state rather than a wrong row. Unknown enum values
 * that only label a row (a procedure kind) pass through with a plain label;
 * the going-concern verdict, whose wording matters, must be one of four.
 */
class UnreadableRecords extends Error {
  constructor(subject: string) {
    super(`The server returned unreadable ${subject}`);
  }
}

type Json = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === "string";
const isBooleanOrNull = (value: unknown) => value === null || typeof value === "boolean";
const isWebUrlOrNull = (value: unknown) => value === null || isHttpUrl(value);
const VERDICTS = new Set(["doubt_raised", "doubt_alleviated", "policy_only", "unclear"]);
const DATE_BASES = new Set(["designation", "effective", "first_observed"]);

function validEvent(value: unknown): value is CloudFilingEventPayload {
  if (!isRecord(value) || !isRecord(value.company)) return false;
  const company = value.company;
  return isNonEmptyText(value.id) && isNonEmptyText(value.ticker)
    && isNonEmptyText(company.name) && isText(company.ticker) && isNullableString(company.cik ?? null)
    && isIsoInstant(value.filedAt)
    && (value.filingDate === undefined || isNullableCalendarDay(value.filingDate))
    && (value.form === undefined || isText(value.form))
    && isHttpUrl(value.docUrl)
    && isStringArray(value.items) && isStringArray(value.labels) && isStringArray(value.kinds)
    && typeof value.material === "boolean"
    && isNullableString(value.headline) && isNullableString(value.summary)
    && Array.isArray(value.people)
    && typeof value.read === "boolean";
}

function parseDistressFilings(value: unknown): DistressFilingsPayload {
  if (!isRecord(value) || !Array.isArray(value.events) || !value.events.every(validEvent)) {
    throw new UnreadableRecords("8-K filings");
  }
  return { events: value.events.map((event) => ({ ...event, people: [] })) };
}

function validDisclosure(value: unknown): value is GoingConcernDisclosure {
  if (!isRecord(value) || !isRecord(value.company)) return false;
  const company = value.company;
  return isNonEmptyText(value.id) && isNonEmptyText(value.cik) && isNullableString(value.ticker)
    && isText(value.accession) && isNonEmptyText(value.form)
    && isNullableCalendarDay(value.period_end) && isCalendarDay(value.filed_at) && isNullableCalendarDay(value.fact_date)
    && isText(value.tag) && VERDICTS.has(value.verdict as string)
    && isBooleanOrNull(value.within_one_year) && isBooleanOrNull(value.source_within_one_year)
    && isText(value.summary) && isText(value.quote) && isText(value.text)
    && typeof value.text_truncated === "boolean" && isText(value.dataset_month)
    && isNonEmptyText(company.name) && isText(company.ticker) && isNullableString(company.cik ?? null)
    && (company.shortName === undefined || isText(company.shortName))
    && isHttpUrl(value.filing_url);
}

function validPage(value: Json): boolean {
  return typeof value.hasMore === "boolean" && isNonNegativeInt(value.offset) && isNonNegativeInt(value.limit);
}

function parseGoingConcern(value: unknown): GoingConcernPayload {
  if (!isRecord(value) || !validPage(value) || !Array.isArray(value.disclosures) || !value.disclosures.every(validDisclosure)) {
    throw new UnreadableRecords("going-concern disclosures");
  }
  return {
    disclosures: value.disclosures.map((row) => ({
      id: row.id, cik: row.cik, ticker: row.ticker, accession: row.accession, form: row.form,
      period_end: row.period_end, filed_at: row.filed_at, fact_date: row.fact_date, tag: row.tag,
      verdict: row.verdict, within_one_year: row.within_one_year, source_within_one_year: row.source_within_one_year,
      summary: row.summary, quote: row.quote, text: row.text, text_truncated: row.text_truncated,
      dataset_month: row.dataset_month,
      company: {
        ticker: row.company.ticker,
        cik: row.company.cik ?? null,
        name: row.company.name,
        shortName: row.company.shortName ?? row.company.name,
      },
      filing_url: row.filing_url,
    })),
    hasMore: value.hasMore as boolean,
    limit: value.limit as number,
    offset: value.offset as number,
  };
}

/**
 * The server's two shapes (a list of dataset pages, or one page) as one list of
 * links. A parsed attribution parses to itself, so cached copies check again.
 */
function parseAttribution(value: unknown): DistressAttribution | null {
  if (!isRecord(value) || !isNonEmptyText(value.source) || !isNonEmptyText(value.organization) || !isNonEmptyText(value.licence)
    || !isHttpUrl(value.licenceUrl) || !isNonEmptyText(value.notice)) return null;
  const datasetUrls: unknown[] = [
    ...(Array.isArray(value.datasetUrls) ? value.datasetUrls : []),
    ...(Array.isArray(value.datasets) ? value.datasets : []),
    ...(value.datasetUrl == null ? [] : [value.datasetUrl]),
  ];
  if (!datasetUrls.every(isHttpUrl)) return null;
  if (value.dataset != null && !isText(value.dataset)) return null;
  if (value.version != null && !isText(value.version)) return null;
  if (value.year != null && !Number.isInteger(value.year)) return null;
  return {
    source: value.source,
    organization: value.organization,
    dataset: (value.dataset as string | null | undefined) ?? null,
    version: (value.version as string | null | undefined) ?? null,
    year: (value.year as number | null | undefined) ?? null,
    datasetUrls: datasetUrls as string[],
    licence: value.licence,
    licenceUrl: value.licenceUrl,
    notice: value.notice,
  };
}

function parseAttributions(value: unknown, subject: string): DistressAttribution[] {
  if (!Array.isArray(value)) throw new UnreadableRecords(subject);
  const parsed = value.map(parseAttribution);
  if (parsed.some((entry) => entry === null)) throw new UnreadableRecords(subject);
  return parsed as DistressAttribution[];
}

function validDesignation(value: unknown): value is DistressDesignation {
  return isRecord(value)
    && isNonEmptyText(value.id) && isNonEmptyText(value.source) && isText(value.region) && isNonEmptyText(value.exchange)
    && isNullableString(value.symbol) && isNonEmptyText(value.local_code)
    && isNonEmptyText(value.entity_name) && isNullableString(value.entity_name_en) && isNullableString(value.market_segment)
    && isNonEmptyText(value.kind)
    && isNullableCalendarDay(value.designated_at) && isNullableCalendarDay(value.effective_at)
    && isIsoInstant(value.first_seen_at) && isIsoInstant(value.last_seen_at) && isNullableIsoInstant(value.ended_at)
    && isText(value.remarks) && isHttpUrl(value.source_url) && isWebUrlOrNull(value.notice_url)
    && DATE_BASES.has(value.date_basis as string)
    // The date the row sorts by must be there.
    && (value.date_basis !== "designation" || value.designated_at !== null)
    && (value.date_basis !== "effective" || value.effective_at !== null);
}

function parseDesignations(value: unknown): DistressDesignationsPayload {
  const subject = "listing designations";
  if (!isRecord(value) || !validPage(value) || !Array.isArray(value.designations) || !value.designations.every(validDesignation)) {
    throw new UnreadableRecords(subject);
  }
  return {
    designations: value.designations.map((row) => ({
      id: row.id, source: row.source, region: row.region, exchange: row.exchange, symbol: row.symbol,
      local_code: row.local_code, entity_name: row.entity_name, entity_name_en: row.entity_name_en,
      market_segment: row.market_segment, kind: row.kind, designated_at: row.designated_at,
      effective_at: row.effective_at, first_seen_at: row.first_seen_at, last_seen_at: row.last_seen_at,
      ended_at: row.ended_at, remarks: row.remarks, source_url: row.source_url, notice_url: row.notice_url,
      date_basis: row.date_basis,
    })),
    hasMore: value.hasMore as boolean,
    limit: value.limit as number,
    offset: value.offset as number,
    attributions: parseAttributions(value.attributions, subject),
  };
}

function validNotice(value: unknown): value is InsolvencyNotice {
  return isRecord(value)
    && isNonEmptyText(value.source) && isNonEmptyText(value.country) && isNonEmptyText(value.registry_id)
    && isNonEmptyText(value.entity_name) && isNullableString(value.symbol)
    && isNonEmptyText(value.kind) && isText(value.raw_code)
    && isNullableCalendarDay(value.notice_date) && isCalendarDay(value.published_date) && isText(value.court)
    && isNonEmptyText(value.notice_id) && isHttpUrl(value.notice_url)
    && isNonEmptyText(value.notice_type) && isNullableString(value.original_notice_id) && isNonEmptyText(value.status);
}

function parseInsolvencyNotices(value: unknown): InsolvencyNoticesPayload {
  const subject = "insolvency notices";
  if (!isRecord(value) || !validPage(value) || !Array.isArray(value.notices) || !value.notices.every(validNotice)) {
    throw new UnreadableRecords(subject);
  }
  return {
    notices: value.notices.map((row) => ({
      source: row.source, country: row.country, registry_id: row.registry_id, entity_name: row.entity_name,
      // No listed-company mapping exists for these notices yet; a symbol is never taken on trust here.
      symbol: null,
      kind: row.kind, raw_code: row.raw_code, notice_date: row.notice_date, published_date: row.published_date,
      court: row.court, notice_id: row.notice_id, notice_url: row.notice_url, notice_type: row.notice_type,
      original_notice_id: row.original_notice_id, status: row.status,
    })),
    hasMore: value.hasMore as boolean,
    limit: value.limit as number,
    offset: value.offset as number,
    attributions: parseAttributions(value.attributions, subject),
  };
}

type DistressApi = Pick<HeadlessPaneApiClient,
  "getPublicDistressFilings" | "getPublicGoingConcern" | "getPublicDistressDesignations" | "getPublicInsolvencyNotices">;

/** Filings are read in one request: the route has no offset, and two hundred covers months of these items. */
const FILINGS_LIMIT = 200;
export const PAGE_LIMIT = 100;
/** The routes refuse an offset past this; a list stops paging there. */
const MAX_OFFSET = 10_000;

/** Whether a page at `nextOffset` can still be asked for. */
export const canPage = (hasMore: boolean, nextOffset: number) => hasMore && nextOffset <= MAX_OFFSET;

const UNAVAILABLE = "These records are not available on this server yet.";

async function read<T>(load: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let raw: unknown;
  try {
    raw = await load();
  } catch (error) {
    throw unavailableOnServer(error, UNAVAILABLE);
  }
  return parse(raw);
}

export function fetchDistressFilings(kind: DistressFilingKind, client: DistressApi = apiClient, signal?: AbortSignal, limit = FILINGS_LIMIT) {
  return read(() => client.getPublicDistressFilings({ kind, limit }, { signal }), parseDistressFilings);
}

export function fetchGoingConcern(params: GoingConcernParams, client: DistressApi = apiClient, signal?: AbortSignal) {
  return read(() => client.getPublicGoingConcern(params, { signal }), parseGoingConcern);
}

export function fetchDesignations(params: DistressDesignationsParams, client: DistressApi = apiClient, signal?: AbortSignal) {
  return read(() => client.getPublicDistressDesignations(params, { signal }), parseDesignations);
}

export function fetchInsolvencyNotices(params: InsolvencyNoticesParams, client: DistressApi = apiClient, signal?: AbortSignal) {
  return read(() => client.getPublicInsolvencyNotices(params, { signal }), parseInsolvencyNotices);
}

/**
 * First pages, kept while the pane is closed. Filings land through the day;
 * the other sources change daily or monthly, so ten minutes is fresh enough
 * for all four. Later pages are always read from the server.
 */
const POLICY = { staleMs: 10 * 60_000, expireMs: 7 * 86_400_000 };
const distressFilingsCache = createPluginCache<DistressFilingsPayload>({ kind: "distress-filings", source: "gloom-cloud", schemaVersion: 1, policy: POLICY });
const goingConcernCache = createPluginCache<GoingConcernPayload>({ kind: "distress-going-concern", source: "gloom-cloud", schemaVersion: 1, policy: POLICY });
const designationsCache = createPluginCache<DistressDesignationsPayload>({ kind: "distress-designations", source: "gloom-cloud", schemaVersion: 1, policy: POLICY });
const insolvencyCache = createPluginCache<InsolvencyNoticesPayload>({ kind: "distress-insolvency", source: "gloom-cloud", schemaVersion: 1, policy: POLICY });

export const DISTRESS_CACHES = [distressFilingsCache, goingConcernCache, designationsCache, insolvencyCache] as const;

/** A first page from the cache, or a later page from the server, with what the footer needs. */
export interface LoadedPage<T> {
  payload: T;
  /** The answer is an older copy because the refresh failed. */
  stale: boolean;
  refreshError: string | null;
  /** When the answer was read from the server, for the refresh schedule. */
  fetchedAt: number;
}

interface Cache<T> {
  load(key: string, loader: () => Promise<T>, options?: { force?: boolean }): Promise<{ data: T; stale: boolean; refreshError?: string; fetchedAt: number }>;
}

/**
 * Only parsed answers reach the cache, and a cached copy is parsed again on the
 * way out, so a copy written by an older build can never be drawn unchecked.
 */
async function loadFirstPage<T>(cache: Cache<T>, key: string, fetch: () => Promise<T>, parse: (value: unknown) => T, force: boolean): Promise<LoadedPage<T>> {
  const result = await cache.load(key, fetch, { force });
  return { payload: parse(result.data), stale: result.stale, refreshError: result.refreshError ?? null, fetchedAt: result.fetchedAt };
}

const fresh = <T,>(payload: T): LoadedPage<T> => ({ payload, stale: false, refreshError: null, fetchedAt: Date.now() });

export function loadDistressFilings(kind: DistressFilingKind, force: boolean, signal?: AbortSignal): Promise<LoadedPage<DistressFilingsPayload>> {
  return loadFirstPage(distressFilingsCache, kind, () => fetchDistressFilings(kind, apiClient, signal), parseDistressFilings, force);
}

export function loadGoingConcern(params: GoingConcernParams, force: boolean, signal?: AbortSignal): Promise<LoadedPage<GoingConcernPayload>> {
  if (params.offset) return fetchGoingConcern(params, apiClient, signal).then(fresh);
  return loadFirstPage(goingConcernCache, JSON.stringify(params), () => fetchGoingConcern(params, apiClient, signal), parseGoingConcern, force);
}

export function loadDesignations(params: DistressDesignationsParams, force: boolean, signal?: AbortSignal): Promise<LoadedPage<DistressDesignationsPayload>> {
  if (params.offset) return fetchDesignations(params, apiClient, signal).then(fresh);
  return loadFirstPage(designationsCache, JSON.stringify(params), () => fetchDesignations(params, apiClient, signal), parseDesignations, force);
}

export function loadInsolvencyNotices(params: InsolvencyNoticesParams, force: boolean, signal?: AbortSignal): Promise<LoadedPage<InsolvencyNoticesPayload>> {
  if (params.offset) return fetchInsolvencyNotices(params, apiClient, signal).then(fresh);
  return loadFirstPage(insolvencyCache, JSON.stringify(params), () => fetchInsolvencyNotices(params, apiClient, signal), parseInsolvencyNotices, force);
}
