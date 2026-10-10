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
    return parts.join(" ") || body;
  } catch {
    return htmlErrorTitle(body) ?? body;
  }
}

/** A JSON error body as an object, or undefined for any other body. */
export function parseApiErrorDetails(body: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The JSON body's `error` field, which routes that name their failures set to a code. */
export function parseApiErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    return typeof parsed?.error === "string" && parsed.error ? parsed.error : undefined;
  } catch {
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
