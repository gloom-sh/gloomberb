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

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isFilled = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";
const isBooleanOrNull = (value: unknown) => value === null || typeof value === "boolean";
const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const isDayOrNull = (value: unknown) => value === null || isDay(value);
const isInstant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const isInstantOrNull = (value: unknown) => value === null || isInstant(value);
/** Only web links are opened; anything else in a link field makes the record unreadable. */
const isWebUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};
const isWebUrlOrNull = (value: unknown) => value === null || isWebUrl(value);
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const VERDICTS = new Set(["doubt_raised", "doubt_alleviated", "policy_only", "unclear"]);
const DATE_BASES = new Set(["designation", "effective", "first_observed"]);

function validEvent(value: unknown): value is CloudFilingEventPayload {
  if (!isObject(value) || !isObject(value.company)) return false;
  const company = value.company;
  return isFilled(value.id) && isFilled(value.ticker)
    && isFilled(company.name) && isText(company.ticker) && isTextOrNull(company.cik ?? null)
    && isInstant(value.filedAt)
    && (value.filingDate === undefined || isDayOrNull(value.filingDate))
    && (value.form === undefined || isText(value.form))
    && isWebUrl(value.docUrl)
    && Array.isArray(value.items) && value.items.every(isText)
    && Array.isArray(value.labels) && value.labels.every(isText)
    && Array.isArray(value.kinds) && value.kinds.every(isText)
    && typeof value.material === "boolean"
    && isTextOrNull(value.headline) && isTextOrNull(value.summary)
    && Array.isArray(value.people)
    && typeof value.read === "boolean";
}

export function parseDistressFilings(value: unknown): DistressFilingsPayload {
  if (!isObject(value) || !Array.isArray(value.events) || !value.events.every(validEvent)) {
    throw new UnreadableRecords("8-K filings");
  }
  return { events: value.events.map((event) => ({ ...event, people: [] })) };
}

function validDisclosure(value: unknown): value is GoingConcernDisclosure {
  if (!isObject(value) || !isObject(value.company)) return false;
  const company = value.company;
  return isFilled(value.id) && isFilled(value.cik) && isTextOrNull(value.ticker)
    && isText(value.accession) && isFilled(value.form)
    && isDayOrNull(value.period_end) && isDay(value.filed_at) && isDayOrNull(value.fact_date)
    && isText(value.tag) && VERDICTS.has(value.verdict as string)
    && isBooleanOrNull(value.within_one_year) && isBooleanOrNull(value.source_within_one_year)
    && isText(value.summary) && isText(value.quote) && isText(value.text)
    && typeof value.text_truncated === "boolean" && isText(value.dataset_month)
    && isFilled(company.name) && isText(company.ticker) && isTextOrNull(company.cik ?? null)
    && (company.shortName === undefined || isText(company.shortName))
    && isWebUrl(value.filing_url);
}

function validPage(value: Json): boolean {
  return typeof value.hasMore === "boolean" && isCount(value.offset) && isCount(value.limit);
}

export function parseGoingConcern(value: unknown): GoingConcernPayload {
  if (!isObject(value) || !validPage(value) || !Array.isArray(value.disclosures) || !value.disclosures.every(validDisclosure)) {
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
  if (!isObject(value) || !isFilled(value.source) || !isFilled(value.organization) || !isFilled(value.licence)
    || !isWebUrl(value.licenceUrl) || !isFilled(value.notice)) return null;
  const datasetUrls: unknown[] = [
    ...(Array.isArray(value.datasetUrls) ? value.datasetUrls : []),
    ...(Array.isArray(value.datasets) ? value.datasets : []),
    ...(value.datasetUrl == null ? [] : [value.datasetUrl]),
  ];
  if (!datasetUrls.every(isWebUrl)) return null;
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
  return isObject(value)
    && isFilled(value.id) && isFilled(value.source) && isText(value.region) && isFilled(value.exchange)
    && isTextOrNull(value.symbol) && isFilled(value.local_code)
    && isFilled(value.entity_name) && isTextOrNull(value.entity_name_en) && isTextOrNull(value.market_segment)
    && isFilled(value.kind)
    && isDayOrNull(value.designated_at) && isDayOrNull(value.effective_at)
    && isInstant(value.first_seen_at) && isInstant(value.last_seen_at) && isInstantOrNull(value.ended_at)
    && isText(value.remarks) && isWebUrl(value.source_url) && isWebUrlOrNull(value.notice_url)
    && DATE_BASES.has(value.date_basis as string)
    // The date the row sorts by must be there.
    && (value.date_basis !== "designation" || value.designated_at !== null)
    && (value.date_basis !== "effective" || value.effective_at !== null);
}

export function parseDesignations(value: unknown): DistressDesignationsPayload {
  const subject = "listing designations";
  if (!isObject(value) || !validPage(value) || !Array.isArray(value.designations) || !value.designations.every(validDesignation)) {
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
  return isObject(value)
    && isFilled(value.source) && isFilled(value.country) && isFilled(value.registry_id)
    && isFilled(value.entity_name) && isTextOrNull(value.symbol)
    && isFilled(value.kind) && isText(value.raw_code)
    && isDayOrNull(value.notice_date) && isDay(value.published_date) && isText(value.court)
    && isFilled(value.notice_id) && isWebUrl(value.notice_url)
    && isFilled(value.notice_type) && isTextOrNull(value.original_notice_id) && isFilled(value.status);
}

export function parseInsolvencyNotices(value: unknown): InsolvencyNoticesPayload {
  const subject = "insolvency notices";
  if (!isObject(value) || !validPage(value) || !Array.isArray(value.notices) || !value.notices.every(validNotice)) {
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
