/** What every surface says when a request to Gloom's data service never got an answer. */
export const DATA_SERVICE_UNREACHABLE_MESSAGE = "Gloom couldn't reach its data service";

/**
 * A request that never reached the data service: no connection, a proxy that
 * refused it, a name that did not resolve. The fetch's own error is the
 * `cause`, and its `code` (Bun's `ConnectionRefused`, Node's `ENOTFOUND`) is
 * kept for code that classifies failures by it.
 */
export class DataServiceUnreachableError extends Error {
  readonly code?: string;

  constructor(cause: unknown) {
    super(DATA_SERVICE_UNREACHABLE_MESSAGE, { cause });
    this.name = "DataServiceUnreachableError";
    const code = (cause as { code?: unknown } | null)?.code;
    if (typeof code === "string") this.code = code;
  }
}

/** Codes a fetch fails with when it got no connection: Bun's, then Node's and the system's. */
const NO_CONNECTION_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UnableToConnect",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);

/**
 * The same failure in the words of each fetch: Bun's ("Unable to connect. Is
 * the computer able to access the url?", which the desktop relays from its Bun
 * process as a plain message), a browser's ("Failed to fetch", Safari's "Load
 * failed", Firefox's "NetworkError when attempting to fetch resource") and
 * Node's ("fetch failed").
 */
const NO_CONNECTION_MESSAGE = /unable to connect|failed to fetch|^load failed$|networkerror when attempting|network connection was lost|appears to be offline|^fetch failed$|typo in the url or port|socket connection was closed unexpectedly/i;

/**
 * Whether a request failed before any answer came back. A caller's abort and
 * a timeout are not: the first is on purpose, and the second reached a server
 * that did not answer in time.
 */
export function isNetworkFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    if (current instanceof DataServiceUnreachableError) return true;
    const { name, code, message } = current as { name?: unknown; code?: unknown; message?: unknown };
    if (name === "AbortError" || name === "TimeoutError") return false;
    if (typeof code === "string" && NO_CONNECTION_CODES.has(code)) return true;
    if (typeof message === "string" && NO_CONNECTION_MESSAGE.test(message.trim())) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return typeof error === "string" && NO_CONNECTION_MESSAGE.test(error.trim());
}

/** A network failure as `DataServiceUnreachableError`; anything else as it was. */
export function asDataServiceFailure(error: unknown): unknown {
  return isNetworkFailure(error) && !(error instanceof DataServiceUnreachableError)
    ? new DataServiceUnreachableError(error)
    : error;
}
