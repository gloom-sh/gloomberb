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
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
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
