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
import { isNetworkFailure } from "../../../utils/network-failure";
import { asRecord, finiteOrNull } from "../../../utils/guards";
import { logFailure } from "../../../utils/log-failure";

const FORMS_13F_BASE_URL = "https://forms13f.com/api/v1";
const FORM_PAGE_LIMIT = 100;
/** The most rows the 13F source gives in one page. */
const FILING_PAGE_ROWS = 250;
/** Pages of one filing read at once where the service cannot send it whole. */
const FILING_PAGE_CONCURRENCY = 4;
// Large funds file tens of thousands of positions (BlackRock about 50,000), and
// a silently clipped list makes every weight, total, and buy/sell action wrong.
const MAX_FORM_ROWS = 100_000;
/** Rows asked first of a large filing the service is still reading. */
const FIRST_ROWS = 2_000;
/** How long a large filing is waited for whole before its first rows are asked. */
const FIRST_ROWS_AFTER_MS = 300;
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
  /**
   * The sign-in the answer is for, when it depends on it (a filing's holdings:
   * the first 1,000 lines signed out, the whole book signed in). Its copy
   * serves only that state and a request in flight only readers bound to the
   * same sign-in. One the sign-in left before it went out, or before it
   * answered, is not sent, kept or answered: it fails with SignInChangedError.
   */
  binding?: SessionBinding;
  /**
   * What every answer is made into before it is kept, answered or read back
   * from a copy (a signed-out reader's filing cut to its anonymous lines).
   */
  shape?: (value: unknown) => unknown;
  /**
   * Keep the copy in memory for the sign-in it was read in, never on disk: a
   * signed-in book is not kept past the session that was sent it.
   */
  memoryOnly?: boolean;
  /** Whether an answer may be saved; every answer by default. */
  keep?: (value: unknown) => boolean;
  signal?: AbortSignal;
  /** Gloom Cloud only: a path the public 13F source does not serve. */
  cloudOnly?: boolean;
  /** When the service's stored copy of the part a reader is shown was read (ms); the oldest of every row by default. */
  shownCopyTime?: (value: unknown) => number | null;
}

let forms13FPersistence: PluginPersistence | null = null;
const failedRefreshes = new Set<string>();
// The promise is the generation. A newer download replaces it, and the replaced one must not write.
const activeRequests = new Map<string, Promise<unknown>>();
/** The service answered a whole filing with 404: it is an older one, so filings are read a page at a time. */
let wholeFilingsMissing = false;
/** Copies kept for one sign-in only (`memoryOnly`), by request and sign-in: emptied whenever who is signed in changes. */
const sessionCopies = new Map<string, unknown>();

export function attachThirteenFApiPersistence(persistence: PluginPersistence) {
  if (forms13FPersistence !== persistence) resetThirteenFApiPersistence();
  forms13FPersistence = persistence;
}

export function resetThirteenFApiPersistence() {
  forms13FPersistence = null;
  failedRefreshes.clear();
  activeRequests.clear();
  sessionCopies.clear();
  wholeFilingsMissing = false;
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

function cacheKey(path: string, params: URLSearchParams, session?: ReaderSession): string {
  const query = params.toString();
  const key = query ? `${path}?${query}` : path;
  return session ? `${key}#${session}` : key;
}

/**
 * Whether a 13F read is asked as signed in: the service answers a reader who
 * is not with less of a filing. It is what the app believes, a token it holds
 * or a user it restored, not proof of the credential a request carries: a
 * read asked signed out is cut to the anonymous lines whatever comes back
 * (anonymousFiling), and one asked signed in is shown only what the service
 * sent it and kept only for that sign-in.
 */
type ReaderSession = "signed-in" | "signed-out";

function readerSession(): ReaderSession {
  return apiClient.isSignedIn() ? "signed-in" : "signed-out";
}

/**
 * The sign-in a read was asked in: its state, the count of sign-in changes
 * then and the credential's generation (a count of credential replacements,
 * never the credential). Signing in and out again while a read is out leaves
 * the state as it was but not the count, so that read is still not the
 * reader's; nor is it once the credential is replaced, before the account the
 * new one belongs to is known.
 */
interface SessionBinding {
  session: ReaderSession;
  changes: number;
  credential: number;
}

/** The sign-in a complete holdings read is bound to: every filing, page and first rows of it are read in this one. */
export type HoldingsSession = SessionBinding;

let signInChanges = 0;
let watchedSignIn: string | null = null;

/**
 * Who is signed in, as far as a 13F answer can differ: signed out, or which
 * account with which credential. A credential replaced under the same account
 * shown (the new one's account not read yet) is another sign-in.
 */
function signInIdentity(): string {
  return apiClient.isSignedIn() ? `in:${apiClient.getCurrentUser()?.id ?? ""}:${apiClient.getCredentialGeneration()}` : "out";
}

function bindReaderSession(): SessionBinding {
  if (watchedSignIn == null) {
    watchedSignIn = signInIdentity();
    // Told of every account change, a plan's or a profile's too: only one that changes who is signed in counts.
    apiClient.subscribeCurrentUser(() => {
      const identity = signInIdentity();
      if (identity !== watchedSignIn) {
        signInChanges += 1;
        sessionCopies.clear();
      }
      watchedSignIn = identity;
    });
  }
  return { session: readerSession(), changes: signInChanges, credential: apiClient.getCredentialGeneration() };
}

/** The reader's sign-in now, as a holdings read started now is bound to it. */
export function currentHoldingsSession(): HoldingsSession {
  return bindReaderSession();
}

/** Whether the sign-in a read is bound to is still the reader's: what it read may be shown, compared or kept. */
export function holdingsSessionCurrent(binding: HoldingsSession): boolean {
  return binding.changes === signInChanges && readerSession() === binding.session
    && apiClient.getCredentialGeneration() === binding.credential;
}

const stillBound = holdingsSessionCurrent;

/** A read the reader's sign-in changed under: what it would send, keep or answer is for a state they left. */
class SignInChangedError extends Error {
  constructor() {
    super("The sign-in changed while this 13F filing was read: read it again.");
    this.name = "SignInChangedError";
  }
}

/** Whether a read failed because the sign-in it was bound to has gone: its parts are thrown away, not reported. */
export function isSignInChange(error: unknown): boolean {
  return error instanceof SignInChangedError;
}

/** Fails a read whose sign-in has gone, before anything it read is used. */
function assertBound(binding: SessionBinding): void {
  if (!stillBound(binding)) throw new SignInChangedError();
}

/** How many times a read the sign-in changed under is asked again, in the new sign-in. */
const SIGN_IN_REREADS = 2;

/**
 * One complete holdings read under one sign-in: the boundary every filing,
 * page, first rows and part shown of it passes. The answer is checked against
 * the sign-in when it comes back, after every wait under it (a copy, a joined
 * request), so nothing read for a sign-in the reader left is used; such a read
 * is thrown away (`onRestart`, for what it showed) and read again in the new
 * sign-in, at most SIGN_IN_REREADS times. Given the `session` of a read it is
 * part of (a pane's, a report's), it is read once in that one, and a change
 * fails it for that read's own boundary.
 */
export async function inHoldingsSession<T>(
  read: (session: HoldingsSession) => Promise<T>,
  signal?: AbortSignal,
  options: { onRestart?: () => void; session?: HoldingsSession } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const binding = options.session ?? bindReaderSession();
    try {
      const value = await read(binding);
      assertBound(binding);
      return value;
    } catch (error) {
      if (!(error instanceof SignInChangedError) || options.session || attempt >= SIGN_IN_REREADS) throw error;
      signal?.throwIfAborted();
      options.onRestart?.();
    }
  }
}

const isRateLimited = (error: unknown): error is ApiRequestError => error instanceof ApiRequestError && error.status === 429;

/** How long to wait before asking again, in whole seconds, from a rate limit's `Retry-After`. */
export function retryAfterSeconds(error: unknown): number | null {
  return isRateLimited(error) && error.retryAfterMs != null && error.retryAfterMs > 0
    ? Math.ceil(error.retryAfterMs / 1000)
    : null;
}

/** A refusal that carries no words of the service's own: an empty body, or the status alone. */
const GENERIC_LIMIT_TEXT = /^\s*(?:(?:HTTP\s*)?429\b.*|too many requests\.?)?\s*$/i;

/**
 * A 13F read the service refused for its signed-out limit: the service's own
 * message when it sent one (it says how long to wait and that signing in lifts
 * the limit), else the same in the app's words. The limit itself is the
 * service's.
 */
export function thirteenFReadError(error: unknown): unknown {
  if (!isRateLimited(error) || !GENERIC_LIMIT_TEXT.test(error.message)) return error;
  const seconds = retryAfterSeconds(error);
  return new ApiRequestError(
    `Too many 13F reads without signing in: try again in ${seconds != null ? `${seconds} s` : "a minute"}, or sign in to lift the limit.`,
    429, error.retryAfterMs, error.code, error.details,
  );
}

/** What a 13F read says when Gloom Cloud was reached and its 13F source failed. */
export const THIRTEENF_SOURCE_UNAVAILABLE = "The 13F source is unavailable right now";

/**
 * A 13F read the service answered with a failure of its own (a 5xx: the 13F
 * source down and nothing stored to answer for it, or the service busy), in
 * the app's words. It answered, so the connection is not what to check. A
 * failure the service named otherwise (EDGAR's) and any other answer (a rate
 * limit, a refused parameter) are as they came.
 */
function thirteenFSourceError(error: unknown): unknown {
  if (!(error instanceof ApiRequestError) || error.status === undefined || error.status < 500) return error;
  if (error.code && error.code !== "source_unavailable") return error;
  return new ApiRequestError(THIRTEENF_SOURCE_UNAVAILABLE, error.status, error.retryAfterMs, "source_unavailable", error.details);
}

/**
 * When the copy Gloom Cloud answered from was read from the 13F source (ms),
 * or null for a fresh answer. While the source is unavailable the service
 * answers from a copy it stored, each row saying when it was read
 * (`stored_as_of`); the oldest is the answer's.
 */
function storedCopyTime(value: unknown): number | null {
  const rows = Array.isArray(value) ? value : [value];
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const at = Date.parse(stringOrEmpty(asRecord(row).stored_as_of));
    if (Number.isFinite(at)) oldest = Math.min(oldest, at);
  }
  return Number.isFinite(oldest) ? oldest : null;
}

/**
 * When a filings list's stored copy was read, by the filings of the quarter a
 * reader is shown (`period`, else the newest the list holds): a fund's row
 * shows that quarter's report alone, so a filing of an older quarter read on
 * an earlier day does not date it (Spark's 30 Sep 13F read on 21 Nov beside
 * its older ones read on 7 Nov).
 */
function quarterCopyTime(period: string | undefined) {
  return (value: unknown): number | null => {
    const rows = Array.isArray(value) ? value : [value];
    const periodOf = (row: unknown) => stringOrEmpty(asRecord(row).period_of_report);
    const quarter = period ?? rows.map(periodOf).reduce((newest, each) => (each > newest ? each : newest), "");
    const shown = rows.filter((row) => periodOf(row) === quarter);
    return storedCopyTime(shown.length > 0 ? shown : rows);
  };
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

  const { binding } = options;
  const shape = (value: unknown) => (options.shape ? options.shape(value) : value) as T;
  const key = cacheKey(path, searchParams, binding?.session);
  // A request in flight, and a copy kept for one sign-in, serve only readers bound to that same sign-in.
  const flightKey = binding ? `${key}@${binding.changes}` : key;
  const bound = () => binding == null || stillBound(binding);
  const persistence = forms13FPersistence;
  const store = options.memoryOnly ? null : persistence;
  const cacheOptions = { sourceKey: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION };
  const kept: { value: T; stale?: boolean } | null = options.cache === false ? null
    : options.memoryOnly ? (sessionCopies.has(flightKey) ? { value: sessionCopies.get(flightKey) as T, stale: false } : null)
      : store?.getResource<T>(CACHE_KIND, key, cacheOptions) ?? null;
  // A copy read back is what a fresh answer would be made: one saved before a signed-out reader's lines were cut is cut.
  const cached = kept ? { stale: kept.stale, value: shape(kept.value) } : null;
  if (cached != null && !options.forceRefresh && !cached.stale && !failedRefreshes.has(key)) return cached.value;

  if (!options.forceRefresh) {
    const pending = activeRequests.get(flightKey) as Promise<T> | undefined;
    if (pending) {
      if (cached != null) return cached.value;
      // Another reader's request, which that reader may stop (a fund read ahead
      // while the cursor rested on it): this reader then asks again on its own.
      return pending.catch((error: unknown) => {
        if (options.signal?.aborted || !(error instanceof Error && error.name === "AbortError")) throw error;
        return fetchForms13F<T>(path, params, options);
      });
    }
  }

  const slot: { promise?: Promise<T> } = {};
  // Only the newest request for the key, in the sign-in it was asked in, writes.
  const current = () => forms13FPersistence === persistence && activeRequests.get(flightKey) === slot.promise && bound();
  const promise = (async (): Promise<T> => {
    // Yield once so the caller can publish this promise before a synchronous abort settles it.
    await Promise.resolve();
    try {
      options.signal?.throwIfAborted();
      // Signed in or out since it was asked: sent now, it would carry the new sign-in under the old one's key.
      if (!bound()) throw new SignInChangedError();
      let value: T;
      try {
        value = await apiClient.getCloudSec13F(path, params, { signal: options.signal }) as T;
      } catch (cloudError) {
        options.signal?.throwIfAborted();
        const error = thirteenFReadError(cloudError);
        if (options.cloudOnly) throw thirteenFSourceError(error);
        const url = `${FORMS_13F_BASE_URL}${path}?${searchParams.toString()}`;
        // A service that answered says what failed (its limit and when to ask again, its source being
        // down); a direct read that cannot connect as well says less: the source is down, not this
        // computer's connection.
        const answered = !isNetworkFailure(error);
        const response = await httpFetch(url, {
          headers: { Accept: "application/json" },
          signal: options.signal,
        }).catch((fallbackError: unknown) => {
          throw answered ? thirteenFSourceError(error) : fallbackError;
        });
        if (!response.ok) {
          if (isRateLimited(error)) throw error;
          throw thirteenFSourceError(new ApiRequestError(`13F source ${response.status} for ${path}`, response.status));
        }
        value = await response.json() as T;
      }
      options.signal?.throwIfAborted();
      // An answer for a sign-in the reader has left is neither kept nor theirs.
      if (!bound()) throw new SignInChangedError();
      value = shape(value);
      // The service's stored copy, while its 13F source is unavailable: said like a saved copy, and
      // not kept as a fresh one, so the next read asks again.
      const storedAt = storedCopyTime(value);
      if (storedAt != null) {
        if (current()) failedRefreshes.add(key);
        options.onSavedCopy?.(options.shownCopyTime?.(value) ?? storedAt);
        return value;
      }
      if (current()) {
        failedRefreshes.delete(key);
        if (value != null && options.cache !== false && (options.keep?.(value) ?? true)) {
          if (options.memoryOnly) sessionCopies.set(flightKey, value);
          else store?.setResource(CACHE_KIND, key, value, { ...cacheOptions, cachePolicy: FORMS_13F_CACHE_POLICY });
        }
      }
      return value;
    } catch (error) {
      options.signal?.throwIfAborted();
      // A failure the old sign-in met (its limit, its refusal) is not the new one's, nor is its saved copy.
      if (error instanceof SignInChangedError) throw error;
      if (!bound()) throw new SignInChangedError();
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
      return shape(retained.value);
    } finally {
      if (activeRequests.get(flightKey) === slot.promise) activeRequests.delete(flightKey);
    }
  })();
  slot.promise = promise;
  activeRequests.set(flightKey, promise);
  if (cached != null && !options.forceRefresh) {
    void promise.catch((error: unknown) => {
      if (!options.signal?.aborted && !(error instanceof SignInChangedError)) logFailure("thirteenf.api", "Refresh cached filing data failed")(error);
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
    ...(raw.sec_list_status === "added" || raw.sec_list_status === "deleted" ? { secListStatus: raw.sec_list_status } : {}),
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
    pnl: raw.ranking_basis === "reported_value" ? null : finiteOrNull(raw.pnl),
    ...(raw.ranking_basis === "reported_value" ? { reportedValue: {
      value: finiteOrNull(raw.table_value_total),
      entries: finiteOrNull(raw.table_entry_total),
      filed: stringOrEmpty(raw.filed_as_of_date),
      through: stringOrEmpty(raw.filings_through),
      complete: raw.ranking_complete === true,
    } } : {}),
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
  /** `shownPeriod`: the list stands for one quarter's report (that one, or "newest"), whose filings date its saved copy. */
  options: Forms13FReadOptions & { offset?: number; shownPeriod?: string } = {},
): Promise<ThirteenFFormSummary[]> {
  const { shownPeriod, ...read } = options;
  const raw = await fetchForms13F<unknown>("/forms", {
    cik: normalizeCik(cik),
    from,
    to,
    limit,
    offset: options.offset ?? 0,
  }, { ...read, signal, ...(shownPeriod ? { shownCopyTime: quarterCopyTime(shownPeriod === "newest" ? undefined : shownPeriod) } : {}) });
  return arrayResponse(raw).map(mapForm).filter((form): form is ThirteenFFormSummary => !!form);
}

/**
 * One page of a filing's information table, no longer than it asked: a longer
 * answer is cut before it is read or kept, a copy of one saved before as well.
 * Standalone (a filing's own list, read as far as it is scrolled) it is the
 * same for every reader. As part of a complete holdings read (`session`) it is
 * that read's sign-in's: kept, and joined, for that sign-in alone, and signed
 * out no further than the filing's first 1,000 lines.
 */
export async function listThirteenFFormHoldingsPage(
  cik: string,
  accessionNumber: string,
  signal?: AbortSignal,
  options: Forms13FReadOptions & { offset?: number; limit?: number; session?: HoldingsSession } = {},
): Promise<{ rows: ThirteenFHoldingRecord[]; hasMore: boolean }> {
  const { session, ...read } = options;
  const offset = Math.max(0, read.offset ?? 0);
  const limit = Math.max(1, read.limit ?? FORM_PAGE_LIMIT);
  const allowed = session?.session === "signed-out" ? Math.min(limit, Math.max(0, SIGNED_OUT_FILING_ROWS - offset)) : limit;
  const raw = await fetchForms13F<unknown>("/form", {
    cik: normalizeCik(cik),
    accession_number: accessionNumber,
    limit,
    offset,
  }, {
    ...read, signal,
    shape: (page: unknown) => (Array.isArray(page) && page.length > allowed ? page.slice(0, allowed) : page),
    ...(session ? { binding: session, memoryOnly: session.session === "signed-in" } : {}),
  });
  const rows = arrayResponse(raw).map(mapHolding).filter((holding): holding is ThirteenFHoldingRecord => !!holding);
  return { rows, hasMore: rows.length >= limit && offset + rows.length < MAX_FORM_ROWS };
}

function mapHoldings(raw: unknown): ThirteenFHoldingRecord[] {
  return arrayResponse(raw).map(mapHolding).filter((holding): holding is ThirteenFHoldingRecord => !!holding);
}

/**
 * A filing's information table as read: its rows; `complete: false` when the
 * answer says they are not the whole table, whether or not the filing's cover
 * counts its lines; and when Gloom Cloud's limit for a reader who is not
 * signed in is what cut it short, that limit (the first 1,000 lines, in the
 * filing's order). Each is as the answer says it: a short read is not by
 * itself that cut, and a whole one says neither.
 */
export interface FilingHoldings {
  rows: ThirteenFHoldingRecord[];
  complete?: false;
  signedOutLimit?: number;
}

/** The lines of a filing a reader who is not signed in is shown: the first 1,000, as Gloom Cloud sends them. */
const SIGNED_OUT_FILING_ROWS = 1_000;

/**
 * A whole-filing answer as a reader asked signed out may have it, whatever the
 * transport sent (a session the app had not seen yet, a copy saved before):
 * its first 1,000 lines, said to be cut by that limit where it held more. An
 * answer within the limit is as it came, its own words on whether it is whole.
 */
function anonymousFiling(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!Array.isArray(record.rows) || record.rows.length <= SIGNED_OUT_FILING_ROWS) return raw;
  return { ...record, rows: record.rows.slice(0, SIGNED_OUT_FILING_ROWS), complete: false, signedOutLimit: SIGNED_OUT_FILING_ROWS };
}

/** A filing's whole information table as Gloom Cloud sends it in one answer. */
function filingRows(raw: unknown): ThirteenFHoldingRecord[] {
  const rows = asRecord(raw).rows;
  if (!Array.isArray(rows)) throw new Error("13F filing answer has no rows");
  return mapHoldings(rows);
}

function filingHoldings(raw: unknown): FilingHoldings {
  const rows = filingRows(raw);
  const { complete, signedOutLimit: limit } = asRecord(raw);
  const capped = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0;
  return { rows, ...(complete === false || capped ? { complete: false as const } : {}), ...(capped ? { signedOutLimit: limit } : {}) };
}

export interface FilingHoldingsOptions extends Forms13FReadOptions {
  /** The rows the filing's summary counts, when known: a large filing's first rows come first. */
  entries?: number | null;
  /** The filing's first rows, while a large filing the service has not read yet is still loading. */
  onFirstRows?: (rows: ThirteenFHoldingRecord[]) => void;
  /**
   * The sign-in of the complete read this filing is part of (inHoldingsSession): its pages and first rows are read
   * in it, and a change fails the read for that boundary to read again. Without one, the filing is its own read.
   */
  session?: HoldingsSession;
}

/**
 * A filing's whole information table: one request to Gloom Cloud, which
 * reads the source's pages itself and keeps the filing. An older service
 * without that answer (a 404, remembered for the session) or one that cannot
 * be reached is read a page at a time, a few pages at once, as before; a page
 * Gloom Cloud cannot send comes from the public source. A busy or failing
 * service (429, 5xx) is the error: paging it would only ask it more.
 */
export async function listThirteenFFormHoldings(
  cik: string,
  accessionNumber: string,
  signal?: AbortSignal,
  options: FilingHoldingsOptions = {},
): Promise<FilingHoldings> {
  const { session, ...read } = options;
  return session ? readFilingHoldings(cik, accessionNumber, signal, read, session)
    : inHoldingsSession((bound) => readFilingHoldings(cik, accessionNumber, signal, read, bound), signal);
}

async function readFilingHoldings(
  cik: string,
  accessionNumber: string,
  signal: AbortSignal | undefined,
  options: Omit<FilingHoldingsOptions, "session">,
  session: HoldingsSession,
): Promise<FilingHoldings> {
  const { entries, onFirstRows, ...readOptions } = options;
  if (wholeFilingsMissing) return listPagedHoldings(cik, accessionNumber, signal, readOptions, session, entries);
  // The count lets a filing the service has not stored yet be read in fewer requests.
  const params = {
    cik: normalizeCik(cik),
    accession_number: accessionNumber,
    ...(entries != null && entries > 0 ? { entries } : {}),
  };
  // Asked signed out, a reader is shown the first 1,000 lines whatever the answer holds, and only those are kept, on
  // disk. Asked signed in, the answer is as the service sent it, kept in memory for that sign-in only, and never when
  // the limit cut it (a session the service did not accept).
  const anonymous = session.session === "signed-out";
  const shape = anonymous ? anonymousFiling : (raw: unknown) => raw;
  const whole = fetchForms13F<unknown>("/holdings", params, {
    ...readOptions, signal, cloudOnly: true, binding: session, shape,
    ...(anonymous ? {} : { memoryOnly: true, keep: (raw: unknown) => asRecord(raw).signedOutLimit == null }),
  });
  let answered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (onFirstRows && entries != null && entries > FIRST_ROWS) {
    timer = setTimeout(() => {
      if (answered || !stillBound(session)) return;
      void fetchForms13F<unknown>("/holdings", { ...params, limit: FIRST_ROWS }, { signal, cloudOnly: true, cache: false, binding: session, shape })
        .then((raw) => { if (!answered && stillBound(session)) onFirstRows(filingRows(raw)); })
        .catch(() => {
          // Intentional ignore: the first rows only come ahead of the whole filing, which reports its own failure.
        });
    }, FIRST_ROWS_AFTER_MS);
  }
  try {
    const holdings = filingHoldings(await whole);
    // A copy or a joined request answers after a wait too: it is the reader's only while the sign-in is.
    assertBound(session);
    return holdings;
  } catch (error) {
    if (error instanceof SignInChangedError) throw error;
    signal?.throwIfAborted();
    const missing = error instanceof ApiRequestError && error.status === 404;
    if (!missing && !isNetworkFailure(error)) throw error;
    if (missing) wholeFilingsMissing = true;
    return listPagedHoldings(cik, accessionNumber, signal, readOptions, session, entries);
  } finally {
    answered = true;
    clearTimeout(timer);
  }
}

/**
 * A filing read a page at a time, a few pages at once, until a page comes back
 * short, every page in the read's sign-in. Asked signed out it stops at the
 * first 1,000 lines, as Gloom Cloud's own answer would: cut by that limit when
 * the cover counts more, or when it counts none and the last page was full, so
 * whether there was more is not known and the read is not called whole.
 */
async function listPagedHoldings(
  cik: string,
  accessionNumber: string,
  signal: AbortSignal | undefined,
  options: Forms13FReadOptions,
  session: HoldingsSession,
  entries: number | null | undefined,
): Promise<FilingHoldings> {
  const pages: ThirteenFHoldingRecord[][] = [];
  const anonymous = session.session === "signed-out";
  const maxRows = anonymous ? SIGNED_OUT_FILING_ROWS : MAX_FORM_ROWS;
  const maxPages = Math.ceil(maxRows / FILING_PAGE_ROWS);
  let next = 0;
  let last: number | null = null;
  let failed = false;
  async function readPage() {
    signal?.throwIfAborted();
    assertBound(session);
    const index = next++;
    const page = await listThirteenFFormHoldingsPage(cik, accessionNumber, signal, {
      ...options,
      offset: index * FILING_PAGE_ROWS,
      limit: FILING_PAGE_ROWS,
      session,
    });
    // A page that came after the sign-in changed is not one of this read's.
    assertBound(session);
    pages[index] = page.rows;
    if (page.rows.length < FILING_PAGE_ROWS && (last === null || index < last)) last = index;
  }
  async function worker() {
    try {
      while (!failed && next < maxPages && (last === null || next <= last)) await readPage();
    } catch (error) {
      failed = true;
      throw error;
    }
  }
  // The first page alone says whether there is more: most filings fit in it.
  await readPage();
  await Promise.all(Array.from({ length: FILING_PAGE_CONCURRENCY }, worker));
  const rows = pages.slice(0, (last ?? maxPages - 1) + 1).flat().slice(0, maxRows);
  const cut = anonymous && last === null && (entries == null || entries > rows.length);
  return cut ? { rows, complete: false, signedOutLimit: SIGNED_OUT_FILING_ROWS } : { rows };
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
  const fallbackFromPeriod = stringOrEmpty(raw.fallbackFromPeriod);
  return {
    cusip: stringOrEmpty(raw.cusip) || cusip,
    periodOfReport: stringOrEmpty(raw.period_of_report) || periodOfReport,
    ...(fallbackFromPeriod ? { fallbackFromPeriod } : {}),
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
