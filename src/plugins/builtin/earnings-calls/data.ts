import {
  apiClient,
  type CloudEarningsCallListPayload,
  type CloudEarningsCallPayload,
  type CloudEarningsTranscriptPayload,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { HeadlessPaneApiClient, PluginPersistence } from "../../../types/plugin";

type EarningsCallsApiClient = Pick<
  HeadlessPaneApiClient,
  "getCloudEarningsCalls" | "getCloudEarningsTranscript"
>;

const LIST_KIND = "calls";
const TRANSCRIPT_KIND = "transcript";
const CACHE_SOURCE = "earnings-calls";
const CACHE_SCHEMA_VERSION = 1;
const LIST_CACHE_SCHEMA_VERSION = 2;

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
  /** Maximum rows requested from the server, which supplies no total/hasMore. */
  sourceLimit?: number;
  /** The response filled its request; additional calls may exist. */
  sourceLimitReached?: boolean;
}

/** A call that has been found but whose transcript is not produced yet. */
export function isShelved(call: CloudEarningsCallPayload): boolean {
  return !call.hasTranscript;
}

/** Short label for the state of a call without a transcript. */
export function callStatusLabel(call: CloudEarningsCallPayload): string {
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

let persistence: PluginPersistence | null = null;
const activeListFetches = new Map<string, Promise<EarningsCallsResult>>();
const activeTranscriptFetches = new Map<string, Promise<CloudEarningsTranscriptPayload>>();

export function attachEarningsCallsPersistence(value: PluginPersistence): void {
  persistence = value;
}

export function resetEarningsCallsPersistence(): void {
  persistence = null;
  activeListFetches.clear();
  activeTranscriptFetches.clear();
}

export function statusOf(error: unknown): number | undefined {
  return error instanceof ApiRequestError ? error.status : undefined;
}

function listLimit(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.min(200, Math.floor(value))) : 50;
}

function listKey(ticker: string | null, limit: number): string {
  return JSON.stringify([ticker, limit]);
}

export async function loadEarningsCallsWithClient(
  client: EarningsCallsApiClient,
  ticker: string | null,
  options?: { force?: boolean; limit?: number },
): Promise<EarningsCallsResult> {
  const normalizedTicker = ticker?.trim().toUpperCase() || null;
  const limit = listLimit(options?.limit);
  const key = listKey(normalizedTicker, limit);
  const force = options?.force ?? false;
  const store = persistence;
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
      limit,
    })
    .then((payload) => {
      const calls = payload.calls ?? [];
      const value = { calls, pending: payload.pending === true, unknownTicker: payload.unknownTicker === true };
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
        return {
          ...expired.value,
          ...sourceScope(expired.value.calls),
          fetchedAt: expired.fetchedAt,
          stale: true,
          refreshError,
          errorStatus,
        };
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
  options?: { force?: boolean; limit?: number },
): Promise<EarningsCallsResult> {
  return loadEarningsCallsWithClient(apiClient, ticker, options);
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
