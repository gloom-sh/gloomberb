import {
  apiClient,
  type CloudEarningsCallPayload,
  type CloudEarningsTranscriptPayload,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { PluginPersistence } from "../../../types/plugin";

const LIST_KIND = "calls";
const TRANSCRIPT_KIND = "transcript";
const CACHE_SOURCE = "earnings-calls";
const CACHE_SCHEMA_VERSION = 1;

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

function listKey(ticker: string | null): string {
  return ticker ? ticker.toUpperCase() : "__all__";
}

export async function loadEarningsCalls(
  ticker: string | null,
  options?: { force?: boolean; limit?: number },
): Promise<EarningsCallsResult> {
  const key = listKey(ticker);
  const force = options?.force ?? false;

  const cached = persistence?.getResource<CloudEarningsCallPayload[]>(LIST_KIND, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
  });
  if (!force && cached && !cached.stale) {
    return { calls: cached.value, fetchedAt: cached.fetchedAt, stale: false };
  }

  const active = activeListFetches.get(key);
  if (active && !force) return active;

  const request = apiClient
    .getCloudEarningsCalls({
      ticker: ticker ?? undefined,
      limit: options?.limit ?? 50,
    })
    .then((payload) => {
      const calls = payload.calls ?? [];
      // A list with calls still being produced changes by the minute, so it
      // is not worth keeping; a list of finished transcripts is.
      const settled = calls.every((call) => call.hasTranscript);
      if (settled) {
        persistence?.setResource(LIST_KIND, key, calls, {
          sourceKey: CACHE_SOURCE,
          schemaVersion: CACHE_SCHEMA_VERSION,
          cachePolicy: LIST_CACHE_POLICY,
        });
      }
      return {
        calls,
        fetchedAt: Date.now(),
        stale: false,
        pending: payload.pending === true,
        unknownTicker: payload.unknownTicker === true,
      };
    })
    .catch((error: unknown) => {
      const refreshError = error instanceof Error ? error.message : String(error);
      const errorStatus = statusOf(error);
      // An auth failure must surface its gate rather than silently showing
      // a cached list the user is no longer entitled to refresh.
      const expired = persistence?.getResource<CloudEarningsCallPayload[]>(LIST_KIND, key, {
        sourceKey: CACHE_SOURCE,
        schemaVersion: CACHE_SCHEMA_VERSION,
        allowExpired: true,
      });
      if (expired && errorStatus !== 401 && errorStatus !== 402 && errorStatus !== 403) {
        return {
          calls: expired.value,
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

/**
 * The server answers 202 with a pending marker when a call is known but not
 * transcribed yet, having just queued it. That is not a transcript and must
 * never be cached.
 */
export function isPendingTranscript(
  value: CloudEarningsTranscriptPayload | { status?: string } | null,
): boolean {
  if (!value) return false
  const record = value as { status?: string; turns?: unknown }
  return record.status === "pending" || !Array.isArray(record.turns)
}

export async function loadTranscript(
  callId: string,
  options?: { force?: boolean },
): Promise<CloudEarningsTranscriptPayload> {
  const force = options?.force ?? false;

  const cached = persistence?.getResource<CloudEarningsTranscriptPayload>(
    TRANSCRIPT_KIND,
    callId,
    { sourceKey: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION },
  );
  if (!force && cached && !cached.stale) return cached.value;

  const active = activeTranscriptFetches.get(callId);
  if (active && !force) return active;

  const request = apiClient
    .getCloudEarningsTranscript(callId)
    .then((transcript) => {
      if (isPendingTranscript(transcript)) return transcript;
      persistence?.setResource(TRANSCRIPT_KIND, callId, transcript, {
        sourceKey: CACHE_SOURCE,
        schemaVersion: CACHE_SCHEMA_VERSION,
        cachePolicy: TRANSCRIPT_CACHE_POLICY,
      });
      return transcript;
    })
    .catch((error: unknown) => {
      const status = statusOf(error);
      const expired = persistence?.getResource<CloudEarningsTranscriptPayload>(
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
