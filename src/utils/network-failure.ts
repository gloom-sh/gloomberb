/** What every surface says when a request to Gloom's data service never got an answer. */
export const DATA_SERVICE_UNREACHABLE_MESSAGE = "Gloom couldn't reach its data service";

/**
 * A request that never reached the data service: no connection, a proxy that
 * refused it, a name that did not resolve, or a connection that hung with
 * nothing coming back before the request's deadline. The fetch's own error (or
 * the deadline's) is the `cause`, and its `code` (Bun's `ConnectionRefused`,
 * Node's `ENOTFOUND`) is kept for code that classifies failures by it.
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

/**
 * Codes a fetch fails with when it never connected: Bun's, then Node's and
 * the system's. A reset or a closed socket is not one: the request may have
 * reached the server.
 */
const NO_CONNECTION_CODES = new Set([
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);

/**
 * The same failure in each fetch's exact words, so a server's or a broker's
 * sentence that merely starts the same way ("Failed to fetch quote from
 * upstream", "Unable to connect to IB Gateway") is not one: Bun's, which the
 * desktop relays from its Bun process as a plain message, then a browser's
 * (Chrome, Safari, Firefox).
 */
const NO_CONNECTION_MESSAGES = new Set([
  "Unable to connect. Is the computer able to access the url?",
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
]);

/** An answer came back: an HTTP status, or an error the server wrote. Its code is the server's, not a socket's. */
function cameFromServer(error: object): boolean {
  const { name, status, statusCode } = error as { name?: unknown; status?: unknown; statusCode?: unknown };
  return typeof status === "number" || typeof statusCode === "number" || name === "ApiRequestError";
}

/**
 * Whether a request failed before any answer came back. A caller's abort and
 * a bare timeout are not: the first is on purpose, and the second may have
 * reached a server that did not answer in time. A Cloud request whose deadline
 * passed with nothing back from the service is one: the client throws it as
 * `DataServiceUnreachableError`, as it does a refused connection. Nor is
 * anything the server answered, whatever its text or code says.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (typeof error === "string") return NO_CONNECTION_MESSAGES.has(error.trim());
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    if (current instanceof DataServiceUnreachableError) return true;
    if (cameFromServer(current)) return false;
    const { name, code, message } = current as { name?: unknown; code?: unknown; message?: unknown };
    if (name === "AbortError" || name === "TimeoutError") return false;
    if (typeof code === "string" && NO_CONNECTION_CODES.has(code)) return true;
    if (typeof message === "string" && NO_CONNECTION_MESSAGES.has(message.trim())) return true;
    // Node's fetch says only "fetch failed" and puts the socket's error in `cause`.
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A network failure as `DataServiceUnreachableError`; anything else as it was. */
export function asDataServiceFailure(error: unknown): unknown {
  return isNetworkFailure(error) && !(error instanceof DataServiceUnreachableError)
    ? new DataServiceUnreachableError(error)
    : error;
}
