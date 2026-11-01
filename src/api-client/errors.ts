import { isNetworkFailure } from "../utils/network-failure";

const HARD_SESSION_INVALID_PATTERNS = [
  /\b(user|account)\b.*\b(not found|deleted|removed|disabled|deactivated|suspended)\b/i,
  /\b(user|account)\b.*\bdoes(?:\s+not|n't)\s+exist\b/i,
  /\b(no|unknown|missing)\s+(user|account)\b/i,
];

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** `Retry-After` in milliseconds when the server sent one. */
    readonly retryAfterMs?: number,
    /** The body's `error` field, e.g. a broker route's "unsupported" or "tool_error". */
    readonly code?: string,
    /** The rest of a JSON error body, for a route that says more, e.g. which user refused a chat. */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** What a pane screenshot's local proxy answers (403) to a request the capture does not send. */
export const SHOT_REQUEST_REFUSED = "The pane screenshot does not send this request.";

/** Whether `error` is the capture's own refusal of a request, not an answer of the service. */
export function isShotRequestRefused(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403 && error.code === SHOT_REQUEST_REFUSED;
}

/**
 * A write refused with 412 because the server holds a newer revision than the
 * one the write was based on. `current` is what the server holds now, or null
 * when it could not be read back.
 */
export class RevisionConflictError<T = unknown> extends Error {
  constructor(
    message: string,
    readonly current: T | null,
    readonly currentRevision: number,
  ) {
    super(message);
    this.name = "RevisionConflictError";
  }
}

/** The server refused the session: signed out, expired, or not allowed this resource. */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
}

/**
 * A client error that retrying will not fix, such as a missing or forbidden
 * resource. Timeouts (408) and rate limits (429) pass with time.
 */
export function isPermanentClientError(error: unknown): boolean {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * A failure asking again shortly may get past: a timeout, a rate limit or an
 * overloaded server (408, 429, 5xx), or a market answer the service marked
 * `retryable_error` because its own upstream was rate limited or timed out.
 */
export function isRetryableApiError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  const status = error.status;
  return error.code === "retryable_error" || status === 408 || status === 429 || (status !== undefined && status >= 500);
}

/**
 * A 200 reply saying its data is unavailable this time (a board's `unavailable`
 * status, a market answer's `retryable_error`): the server's own source did
 * not answer. Like a 5xx it may pass, so a saved copy answers it with its note.
 * A permanent reason (a route not served yet, an unsupported symbol or series,
 * sign-in or entitlement) comes as its status, or as a plain error, and stays
 * the error.
 */
export function sourceDidNotAnswer(message: string): ApiRequestError {
  return new ApiRequestError(message, undefined, undefined, "retryable_error");
}

// Registered, so a mark set by another copy of this module is still read.
const ASKED_TWICE = Symbol.for("gloomberb.listingReadAskedTwice");

/**
 * Marks a listing read's failure, or its failed answer, as the second of two
 * asks (`CloudDataApi.readListing`). Only such a failure is said to be the data
 * service not answering; any other 5xx keeps the server's own words.
 */
export function markAskedTwice<T>(value: T): T {
  if (value && typeof value === "object" && Object.isExtensible(value) && !wasAskedTwice(value)) {
    Object.defineProperty(value, ASKED_TWICE, { value: true });
  }
  return value;
}

/** Whether a failure, or a failed answer, came from a listing read asked twice (`markAskedTwice`). */
export function wasAskedTwice(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[ASKED_TWICE] === true;
}

/** Codes of a connection that dropped or stalled after it opened: Node's and the system's, then Bun's. */
const INTERRUPTED_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ConnectionClosed"]);

/**
 * A failure asking again later may get past, which a copy saved earlier may
 * answer for: no connection, a connection that dropped, a timeout, or a server
 * that was rate limited or overloaded (408, 429, 5xx). Anything else the
 * server answered (another 4xx) and an answer that failed validation are
 * refusals to show as errors, saved copy or not. A bare throw with nothing to
 * classify is not taken for a refusal.
 */
export function isTransientFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return typeof error !== "string" || isNetworkFailure(error);
  if (isNetworkFailure(error) || isRetryableApiError(error)) return true;
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    if (current instanceof ApiRequestError) return false;
    const { name, code } = current as { name?: unknown; code?: unknown };
    if (name === "AbortError" || name === "TimeoutError") return true;
    if (typeof code === "string" && INTERRUPTED_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Reads `Retry-After` as milliseconds, accepting seconds or an HTTP date. */
export function parseRetryAfterMs(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export function parseApiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const parts = [
      parsed.message,
      parsed.error,
      parsed.code,
      parsed.reason,
    ].filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    return parts.join(" ") || validationErrorText(parsed) || body;
  } catch {
    return htmlErrorTitle(body) ?? body;
  }
}

/**
 * A request the API's schema refused comes back as the values it was sent
 * (`{"type":"validation","on":"query","found":{...}}`), which is no message to
 * show; it is said in words instead.
 */
function validationErrorText(parsed: Record<string, unknown>): string | null {
  if (parsed.type !== "validation") return null;
  return parsed.on === "query" ? "Gloom Cloud did not accept an option or filter value." : "Gloom Cloud did not accept the request.";
}

/** A JSON error body as an object, or undefined for any other body. */
export function parseApiErrorDetails(body: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    // Intentional ignore: Non-JSON error responses retain their HTTP status and original body.
    return undefined;
  }
}

/** The JSON body's `error` field, which routes that name their failures set to a code. */
export function parseApiErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    return typeof parsed?.error === "string" && parsed.error ? parsed.error : undefined;
  } catch {
    // Intentional ignore: Non-JSON error responses retain their HTTP status and original body.
    return undefined;
  }
}

/**
 * A proxy in front of the API (Cloudflare) can replace an error body with its
 * own HTML page; its title ("api.gloom.sh | 502: Bad gateway") is the message.
 */
function htmlErrorTitle(body: string): string | null {
  if (!/^\s*<(?:!doctype\s+html|html)[\s>]/i.test(body)) return null;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim();
  return title?.split(" | ").at(-1) || "The server returned an error page.";
}

export function isHardSessionInvalidMessage(message: string): boolean {
  const normalized = message.replace(/[_-]+/g, " ");
  return HARD_SESSION_INVALID_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}
