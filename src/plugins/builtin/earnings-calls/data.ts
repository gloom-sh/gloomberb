import {
  apiClient,
  type CloudEarningsCallAudioPayload,
  type CloudEarningsCallListPayload,
  type CloudEarningsCallPayload,
  type CloudEarningsTranscriptPayload,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { listingAbroad, type IssuerListingParams, type ListingAbroad } from "../../../api-client/paths";
import { servedFromSavedCopy } from "../../../data/saved-copies";
import { areDifferentCompanies } from "../../../sources/sec-registrant";
import type { HeadlessPaneApiClient, PluginPersistence } from "../../../types/plugin";
import { shortDate } from "../earnings/format";
import { callCountdown, callDay, callTimeKnown, isUpcomingCall } from "./upcoming";
import { type CompanyFrom, readCompanyFrom } from "../../../types/company-from";

type EarningsCallsApiClient = Pick<
  HeadlessPaneApiClient,
  "getCloudEarningsCalls" | "getCloudEarningsTranscript"
>;

const LIST_KIND = "calls";
const TRANSCRIPT_KIND = "transcript";
const CACHE_SOURCE = "earnings-calls";
const CACHE_SCHEMA_VERSION = 1;
// Version 3: a listing abroad is keyed by its venue and company, not its symbol alone.
const LIST_CACHE_SCHEMA_VERSION = 3;

/** The call list changes as new transcripts publish. */
const LIST_CACHE_POLICY = {
  staleMs: 15 * 60 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * A published transcript is immutable: the call already happened and the audio
 * is transcribed once. Keep it for a long time so re-reading is instant.
 */
const TRANSCRIPT_CACHE_POLICY = {
  staleMs: 30 * 24 * 60 * 60 * 1000,
  expireMs: 365 * 24 * 60 * 60 * 1000,
} as const;

export interface EarningsCallsResult {
  calls: CloudEarningsCallPayload[];
  fetchedAt: number;
  stale: boolean;
  refreshError?: string;
  /** HTTP status when the request failed, used to pick the right gate. */
  errorStatus?: number;
  /** The server has just started looking for this company's calls. */
  pending?: boolean;
  /** The symbol is not one the SEC knows, so there is nothing to look for. */
  unknownTicker?: boolean;
  /** The company's home line the calls are read from, when not the listing asked. */
  companyFrom?: CompanyFrom | null;
  /** Maximum rows requested from the server, which supplies no total/hasMore. */
  sourceLimit?: number;
  /** The response filled its request; additional calls may exist. */
  sourceLimitReached?: boolean;
}

/** Short label for the state of a call without a transcript; "upcoming" for one still to come. */
export function callStatusLabel(call: CloudEarningsCallPayload, now = Date.now()): string {
  if (isUpcomingCall(call, now)) return "upcoming";
  switch (call.status) {
    case "available":
      return "on request";
    case "capturing":
    case "transcribing":
    case "enriching":
      return "in progress";
    case "discovered":
    case "failed":
      return "queued";
    default:
      return "";
  }
}

/** How long after its start a call not yet transcribed reads as started rather than queued. */
const STARTED_FOR_MS = 3 * 60 * 60 * 1000;

/**
 * What the IN column says: how far away a call still to come is, and for one
 * over, where its transcript is.
 */
export function calendarAway(call: CloudEarningsCallPayload, now: number): string {
  if (isUpcomingCall(call, now)) return callCountdown(call, now);
  if (call.hasTranscript) return "transcribed";
  const label = callStatusLabel(call, now);
  if (label === "in progress") return label;
  const started = callTimeKnown(call) ? now - Date.parse(call.callAt!) : Number.POSITIVE_INFINITY;
  return started < STARTED_FOR_MS ? "started" : label;
}

/** What the pane's notice and `fn CALLS` say when the calendar may be cut. */
export function upcomingCutNotice(calls: readonly CloudEarningsCallPayload[]): string {
  // The server answers earliest first, so the cut is late on the last day it reached.
  const last = calls.length > 0 ? callDay(calls[calls.length - 1]!) : null;
  return `The calendar stops at ${UPCOMING_LIMIT.toLocaleString("en-US")} calls${last ? `: later calls from ${shortDate(last)} on may be missing` : ""}.`;
}

const UPCOMING_KIND = "upcoming";
const UPCOMING_CACHE_SCHEMA_VERSION = 1;
/** The calendar moves as calls are found ahead and transcribed after; a day-old one is no calendar. */
const UPCOMING_CACHE_POLICY = {
  staleMs: 5 * 60 * 1000,
  expireMs: 24 * 60 * 60 * 1000,
} as const;
/**
 * The most calls one calendar asks for, the server's own cap. A peak week of
 * the reporting season holds about 600, so a week is never cut; a calendar
 * that gets this many says it may be (`truncated`).
 */
export const UPCOMING_LIMIT = 1500;

/** Every company's calls on New York days `from` to `to`, earliest first. */
export interface UpcomingCallsResult {
  calls: CloudEarningsCallPayload[];
  fetchedAt: number;
  stale: boolean;
  /** The server answered its limit's worth: calls later on these days may be missing. */
  truncated?: boolean;
  refreshError?: string;
  errorStatus?: number;
}

export interface UpcomingDays {
  from: string;
  to: string;
}

let persistence: PluginPersistence | null = null;
const activeUpcomingFetches = new Map<string, Promise<UpcomingCallsResult>>();
const activeListFetches = new Map<string, Promise<EarningsCallsResult>>();
const activeTranscriptFetches = new Map<string, Promise<CloudEarningsTranscriptPayload>>();

export function attachEarningsCallsPersistence(value: PluginPersistence): void {
  persistence = value;
}

export function resetEarningsCallsPersistence(): void {
  persistence = null;
  activeUpcomingFetches.clear();
  activeListFetches.clear();
  activeTranscriptFetches.clear();
  heldAudio.clear();
}

export function statusOf(error: unknown): number | undefined {
  return error instanceof ApiRequestError ? error.status : undefined;
}

function listLimit(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.min(200, Math.floor(value))) : 50;
}

function listOffset(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** A listing abroad is its venue and company, so it never shares an entry with a US company of the same symbol. */
function listKey(ticker: string | null, abroad: ListingAbroad | null, limit: number, offset: number): string {
  const identity = abroad ? [abroad.symbol, abroad.exchange, abroad.name ?? null] : ticker;
  return offset > 0 ? JSON.stringify([identity, limit, offset]) : JSON.stringify([identity, limit]);
}

/**
 * A server that predates venue-aware lookups ignores the venue and lists the
 * calls of the US company with the same symbol: AI in Paris would show C3.ai.
 * Those calls are another company's, so they are dropped, and without the
 * listing's company they cannot be told apart.
 */
function listingCalls(calls: CloudEarningsCallPayload[], abroad: ListingAbroad | null): CloudEarningsCallPayload[] {
  if (!abroad) return calls;
  const name = abroad.name;
  return name ? calls.filter((call) => !areDifferentCompanies(name, call.companyName)) : [];
}

type EarningsCallsLoadOptions = IssuerListingParams & { force?: boolean; limit?: number; offset?: number };

export async function loadEarningsCallsWithClient(
  client: EarningsCallsApiClient,
  ticker: string | null,
  options?: EarningsCallsLoadOptions,
): Promise<EarningsCallsResult> {
  const normalizedTicker = ticker?.trim().toUpperCase() || null;
  const abroad = normalizedTicker ? listingAbroad(normalizedTicker, options?.exchange, options?.name) : null;
  const limit = listLimit(options?.limit);
  const offset = listOffset(options?.offset);
  const key = listKey(normalizedTicker, abroad, limit, offset);
  const force = options?.force ?? false;
  // Only the first page is worth keeping. A later page is an artefact of how
  // far somebody scrolled, over a shelf that reorders as transcripts publish,
  // so it is fetched live and never serves as the cached answer for the pane.
  const store = offset > 0 ? null : persistence;
  const sourceScope = (calls: CloudEarningsCallPayload[]) => ({
    sourceLimit: limit,
    sourceLimitReached: calls.length >= limit,
  });

  const cached = store?.getResource<CloudEarningsCallListPayload>(LIST_KIND, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: LIST_CACHE_SCHEMA_VERSION,
  });
  if (!force && cached && !cached.stale) {
    return { ...cached.value, ...sourceScope(cached.value.calls), fetchedAt: cached.fetchedAt, stale: false };
  }

  const active = activeListFetches.get(key);
  if (active && !force) return active;

  const request = client
    .getCloudEarningsCalls({
      ticker: normalizedTicker ?? undefined,
      ...(abroad ? { exchange: abroad.exchange, ...(abroad.name ? { name: abroad.name } : {}) } : {}),
      limit,
      ...(offset > 0 ? { offset } : {}),
    })
    .then((payload) => {
      // Calls the service read from the company's home line are the company's, whatever the line's own name.
      const companyFrom = readCompanyFrom(payload.companyFrom);
      const calls = companyFrom ? payload.calls ?? [] : listingCalls(payload.calls ?? [], abroad);
      const value = {
        calls,
        pending: payload.pending === true,
        unknownTicker: payload.unknownTicker === true,
        ...(companyFrom ? { companyFrom } : {}),
      };
      // A list with calls still being produced changes by the minute, so it
      // is not worth keeping; a list of finished transcripts is.
      const settled = !value.pending && calls.every((call) => call.hasTranscript);
      // Only the latest request for this scope may change persistence. A slow
      // earlier load must not rewind a force refresh or a new plugin session.
      if (activeListFetches.get(key) === request && persistence === store && settled) {
        store?.setResource(LIST_KIND, key, value, {
          sourceKey: CACHE_SOURCE,
          schemaVersion: LIST_CACHE_SCHEMA_VERSION,
          cachePolicy: LIST_CACHE_POLICY,
        });
      } else if (activeListFetches.get(key) === request && persistence === store) {
        store?.deleteResource(LIST_KIND, key, { sourceKey: CACHE_SOURCE });
      }
      return {
        ...value,
        ...sourceScope(calls),
        fetchedAt: Date.now(),
        stale: false,
      };
    })
    .catch((error: unknown) => {
      const refreshError = error instanceof Error ? error.message : String(error);
      const errorStatus = statusOf(error);
      // An auth failure must surface its gate rather than silently showing
      // a cached list the user is no longer entitled to refresh.
      const expired = store?.getResource<CloudEarningsCallListPayload>(LIST_KIND, key, {
        sourceKey: CACHE_SOURCE,
        schemaVersion: LIST_CACHE_SCHEMA_VERSION,
        allowExpired: true,
      });
      if (expired && errorStatus !== 401 && errorStatus !== 402 && errorStatus !== 403) {
        // A command that shows it ends with when the copy was saved, not with the failure.
        return servedFromSavedCopy({
          ...expired.value,
          ...sourceScope(expired.value.calls),
          fetchedAt: expired.fetchedAt,
          stale: true,
          refreshError,
          errorStatus,
        }, expired.fetchedAt);
      }
      throw error;
    })
    .finally(() => {
      if (activeListFetches.get(key) === request) activeListFetches.delete(key);
    });

  activeListFetches.set(key, request);
  return request;
}

export function loadEarningsCalls(
  ticker: string | null,
  options?: EarningsCallsLoadOptions,
): Promise<EarningsCallsResult> {
  return loadEarningsCallsWithClient(apiClient, ticker, options);
}

export function cachedEarningsCalls(
  ticker: string | null,
  options?: IssuerListingParams & { limit?: number },
): EarningsCallsResult | null {
  const normalizedTicker = ticker?.trim().toUpperCase() || null;
  const abroad = normalizedTicker ? listingAbroad(normalizedTicker, options?.exchange, options?.name) : null;
  const limit = listLimit(options?.limit);
  const cached = persistence?.getResource<CloudEarningsCallListPayload>(LIST_KIND, listKey(normalizedTicker, abroad, limit, 0), {
    sourceKey: CACHE_SOURCE,
    schemaVersion: LIST_CACHE_SCHEMA_VERSION,
    allowExpired: true,
  });
  if (!cached) return null;
  return {
    ...cached.value,
    sourceLimit: limit,
    sourceLimitReached: cached.value.calls.length >= limit,
    fetchedAt: cached.fetchedAt,
    stale: cached.stale === true,
  };
}

/**
 * A server from before the calendar answers the shelf of transcripts, whatever
 * the days: only calls on those days are the calendar's.
 */
function onDays(calls: CloudEarningsCallPayload[], days: UpcomingDays): CloudEarningsCallPayload[] {
  return calls.filter((call) => {
    const day = callDay(call);
    return day !== null && day >= days.from && day <= days.to;
  });
}

type UpcomingCallsClient = Pick<HeadlessPaneApiClient, "getCloudEarningsCalls">;
type UpcomingCacheValue = { calls: CloudEarningsCallPayload[]; truncated?: boolean };

function upcomingFromCache(value: UpcomingCacheValue, fetchedAt: number, stale: boolean): UpcomingCallsResult {
  return { calls: value.calls, fetchedAt, stale, ...(value.truncated ? { truncated: true } : {}) };
}

export async function loadUpcomingCallsWithClient(
  client: UpcomingCallsClient,
  days: UpcomingDays,
  options: { force?: boolean } = {},
): Promise<UpcomingCallsResult> {
  const key = JSON.stringify([days.from, days.to]);
  const store = persistence;
  const read = (allowExpired: boolean) => store?.getResource<UpcomingCacheValue>(UPCOMING_KIND, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: UPCOMING_CACHE_SCHEMA_VERSION,
    ...(allowExpired ? { allowExpired: true } : {}),
  });
  const cached = read(false);
  if (!options.force && cached && !cached.stale) return upcomingFromCache(cached.value, cached.fetchedAt, false);
  const active = activeUpcomingFetches.get(key);
  if (active && !options.force) return active;

  const request = client
    .getCloudEarningsCalls({ upcoming: days, limit: UPCOMING_LIMIT })
    .then((payload) => {
      const answered = payload.calls ?? [];
      const value: UpcomingCacheValue = {
        calls: onDays(answered, days),
        // A full answer may stop partway through the last day it reaches.
        ...(answered.length >= UPCOMING_LIMIT ? { truncated: true } : {}),
      };
      if (activeUpcomingFetches.get(key) === request && persistence === store) {
        store?.setResource(UPCOMING_KIND, key, value, {
          sourceKey: CACHE_SOURCE,
          schemaVersion: UPCOMING_CACHE_SCHEMA_VERSION,
          cachePolicy: UPCOMING_CACHE_POLICY,
        });
      }
      return upcomingFromCache(value, Date.now(), false);
    })
    .catch((error: unknown) => {
      const errorStatus = statusOf(error);
      // Losing Pro access re-gates the calendar, as it does the list.
      const expired = read(true);
      if (expired && errorStatus !== 401 && errorStatus !== 402 && errorStatus !== 403) {
        return servedFromSavedCopy({
          ...upcomingFromCache(expired.value, expired.fetchedAt, true),
          refreshError: error instanceof Error ? error.message : String(error),
          errorStatus,
        }, expired.fetchedAt);
      }
      throw error;
    })
    .finally(() => {
      if (activeUpcomingFetches.get(key) === request) activeUpcomingFetches.delete(key);
    });
  activeUpcomingFetches.set(key, request);
  return request;
}

export function loadUpcomingCalls(days: UpcomingDays, options?: { force?: boolean }): Promise<UpcomingCallsResult> {
  return loadUpcomingCallsWithClient(apiClient, days, options);
}

export function cachedUpcomingCalls(days: UpcomingDays): UpcomingCallsResult | null {
  const cached = persistence?.getResource<UpcomingCacheValue>(UPCOMING_KIND, JSON.stringify([days.from, days.to]), {
    sourceKey: CACHE_SOURCE,
    schemaVersion: UPCOMING_CACHE_SCHEMA_VERSION,
    allowExpired: true,
  });
  return cached ? upcomingFromCache(cached.value, cached.fetchedAt, cached.stale === true) : null;
}

/**
 * The server answers 202 with a pending marker when a call is known but not
 * transcribed yet, having just queued it. That is not a transcript and must
 * never be cached.
 */
export function isPendingTranscript(
  value: CloudEarningsTranscriptPayload | { status?: string } | null,
): boolean {
  if (!value) return false;
  const record = value as { status?: string; turns?: unknown };
  return record.status === "pending" || !Array.isArray(record.turns);
}

export async function loadTranscriptWithClient(
  client: EarningsCallsApiClient,
  callId: string,
  options?: { force?: boolean },
): Promise<CloudEarningsTranscriptPayload> {
  const force = options?.force ?? false;
  const store = persistence;

  const cached = store?.getResource<CloudEarningsTranscriptPayload>(
    TRANSCRIPT_KIND,
    callId,
    { sourceKey: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION },
  );
  if (!force && cached && !cached.stale) return cached.value;

  const active = activeTranscriptFetches.get(callId);
  if (active && !force) return active;

  const request = client
    .getCloudEarningsTranscript(callId)
    .then((transcript) => {
      if (activeTranscriptFetches.get(callId) === request && persistence === store) {
        if (isPendingTranscript(transcript)) {
          store?.deleteResource(TRANSCRIPT_KIND, callId, { sourceKey: CACHE_SOURCE });
        } else {
          store?.setResource(TRANSCRIPT_KIND, callId, transcript, {
            sourceKey: CACHE_SOURCE,
            schemaVersion: CACHE_SCHEMA_VERSION,
            cachePolicy: TRANSCRIPT_CACHE_POLICY,
          });
        }
      }
      return transcript;
    })
    .catch((error: unknown) => {
      const status = statusOf(error);
      const expired = store?.getResource<CloudEarningsTranscriptPayload>(
        TRANSCRIPT_KIND,
        callId,
        {
          sourceKey: CACHE_SOURCE,
          schemaVersion: CACHE_SCHEMA_VERSION,
          allowExpired: true,
        },
      );
      // Losing Pro access must re-gate the transcript, not serve it from cache.
      if (expired && status !== 401 && status !== 402 && status !== 403) {
        return expired.value;
      }
      throw error;
    })
    .finally(() => {
      if (activeTranscriptFetches.get(callId) === request) {
        activeTranscriptFetches.delete(callId);
      }
    });

  activeTranscriptFetches.set(callId, request);
  return request;
}

export function loadTranscript(
  callId: string,
  options?: { force?: boolean },
): Promise<CloudEarningsTranscriptPayload> {
  return loadTranscriptWithClient(apiClient, callId, options);
}

/**
 * A call's audio, held in memory only: its address is signed and expires, so
 * it is never written to the cache. One with a few minutes left, or a call
 * known to have none, is answered without asking again.
 */
const heldAudio = new Map<string, { audio: CloudEarningsCallAudioPayload | null; until: number }>();
const AUDIO_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const NO_AUDIO_RECHECK_MS = 10 * 60 * 1000;

/** True once a signed address has run out, or is about to. */
export function callAudioExpired(audio: CloudEarningsCallAudioPayload, now = Date.now()): boolean {
  return now >= Date.parse(audio.expiresAt) - 60_000;
}

type CallAudioClient = { getCloudEarningsCallAudio(id: string): Promise<CloudEarningsCallAudioPayload> };

/** The recording to play beside a call's transcript, or null when it has none. */
export function loadCallAudio(
  callId: string,
  options: { force?: boolean } = {},
): Promise<CloudEarningsCallAudioPayload | null> {
  return loadCallAudioWithClient(apiClient, callId, options);
}

export async function loadCallAudioWithClient(
  client: CallAudioClient,
  callId: string,
  options: { force?: boolean; now?: number } = {},
): Promise<CloudEarningsCallAudioPayload | null> {
  const now = options.now ?? Date.now();
  const held = heldAudio.get(callId);
  if (!options.force && held && held.until > now) return held.audio;
  try {
    const audio = await client.getCloudEarningsCallAudio(callId);
    const expires = Date.parse(audio.expiresAt);
    heldAudio.set(callId, { audio, until: Number.isFinite(expires) ? expires - AUDIO_EXPIRY_MARGIN_MS : now });
    return audio;
  } catch (error) {
    const status = statusOf(error);
    // Signed out, unverified or without Pro is no player, like a call with no
    // recording, and says nothing: only a failing server or network does. A
    // refusal is not held, so signing in or upgrading plays on the next look.
    if (status === 401 || status === 402 || status === 403) return null;
    if (status !== 404) throw error;
    heldAudio.set(callId, { audio: null, until: now + NO_AUDIO_RECHECK_MS });
    return null;
  }
}
