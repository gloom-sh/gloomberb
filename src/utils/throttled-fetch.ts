
/**
 * Rate-limited fetch with per-host throttling, retry with backoff, and request deduplication.
 *
 * Usage:
 *   const client = createThrottledFetch({ requestsPerMinute: 30 });
 *   const data = await client.fetch("https://api.example.com/data");
 */

import { abortError, signalWithTimeout } from "./async-deadline";
import { httpFetch } from "./http-transport";

const DEFAULT_REQUESTS_PER_MINUTE = 30;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;

export interface ThrottledFetchOptions {
  /** Max requests per minute per host. Default: 30 */
  requestsPerMinute?: number;
  /** Max retries on 429, 5xx, timeouts and network errors. Default: 2 */
  maxRetries?: number;
  /** Timeout of each attempt in ms, also when the caller passes a signal. Default: 10000 */
  timeoutMs?: number;
  /** Initial retry backoff in ms. Default: 1000 */
  backoffBaseMs?: number;
  /** Default headers applied to every request */
  defaultHeaders?: Record<string, string>;
  /** Share concurrent GET requests to the same URL. Default: true */
  dedupeGetRequests?: boolean;
  /** Override the underlying request transport for this client */
  transport?: ThrottledFetchTransport;
}

export interface ThrottledFetchClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
}

export type ThrottledFetchTransport = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export function createThrottledFetch(
  options: ThrottledFetchOptions = {},
): ThrottledFetchClient {
  const requestsPerMinute =
    options.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
  const defaultHeaders = options.defaultHeaders ?? {};
  const dedupeGetRequests = options.dedupeGetRequests ?? true;
  const fetchTransport =
    options.transport ?? httpFetch;

  // Sliding window: track timestamps of recent requests per host
  const hostTimestamps = new Map<string, number[]>();

  // Deduplication: in-flight requests by URL
  const inflight = new Map<string, Promise<Response>>();

  function getHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return "unknown";
    }
  }

  function getDelayMs(host: string): number {
    const timestamps = hostTimestamps.get(host);
    if (!timestamps || timestamps.length === 0) return 0;

    const windowStart = Date.now() - 60_000;
    // Prune old entries
    while (timestamps.length > 0 && timestamps[0]! < windowStart) {
      timestamps.shift();
    }

    if (timestamps.length < requestsPerMinute) return 0;

    // Delay until the oldest request in the window falls outside
    const oldest = timestamps[0]!;
    return Math.max(0, oldest + 60_000 - Date.now() + 50); // +50ms buffer
  }

  function recordRequest(host: string): void {
    let timestamps = hostTimestamps.get(host);
    if (!timestamps) {
      timestamps = [];
      hostTimestamps.set(host, timestamps);
    }
    timestamps.push(Date.now());
  }

  function getBackoffMs(retriesLeft: number, retryAfter?: string | null): number {
    const attempt = maxRetries - retriesLeft + 1;
    const backoff = backoffBaseMs * 2 ** (attempt - 1);
    const retryAfterMs = retryAfter
      ? (parseInt(retryAfter, 10) || 0) * 1000
      : 0;
    return Math.max(retryAfterMs, backoff);
  }

  // Retry rule: a timeout or network error is retried while retries remain,
  // unless the caller's own signal has aborted. Once the caller aborted, the
  // request ends with their abort reason: no further attempt and no backoff,
  // including while waiting on the rate limit or a backoff. An AbortError that
  // is not the caller's can only come from the attempt's timeout (or the
  // transport giving up), so it counts as a timeout.
  function isRetryableFetchError(error: unknown): boolean {
    const detail =
      error instanceof Error
        ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? "")}`
        : String(error);
    return /TimeoutError|AbortError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket connection|socket hang up|fetch failed|network connection|connection closed/i.test(
      detail,
    );
  }

  function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? abortError("The operation was aborted.");
  }

  function throwIfAborted(signal: AbortSignal | null | undefined): void {
    if (signal?.aborted) throw abortReason(signal);
  }

  /** Waits `ms`, or rejects with the caller's abort reason as soon as the signal fires. */
  function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal!));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function executeRequest(
    url: string,
    init: RequestInit | undefined,
    retriesLeft: number,
  ): Promise<Response> {
    const callerSignal = init?.signal;
    throwIfAborted(callerSignal);

    const host = getHost(url);

    // Wait for rate limit window
    const delay = getDelayMs(host);
    if (delay > 0) {
      await wait(delay, callerSignal);
    }

    recordRequest(host);

    const mergedInit: RequestInit = {
      ...init,
      headers: {
        ...defaultHeaders,
        ...((init?.headers as Record<string, string>) ?? {}),
      },
      signal: signalWithTimeout(callerSignal ?? undefined, timeoutMs),
    };

    let resp: Response;
    try {
      resp = await fetchTransport(url, mergedInit);
    } catch (error) {
      throwIfAborted(callerSignal);
      if (retriesLeft > 0 && isRetryableFetchError(error)) {
        await wait(getBackoffMs(retriesLeft), callerSignal);
        return executeRequest(url, init, retriesLeft - 1);
      }
      throw error;
    }

    // Retry on 429 or 5xx
    if ((resp.status === 429 || resp.status >= 500) && retriesLeft > 0) {
      throwIfAborted(callerSignal);
      await wait(
        getBackoffMs(retriesLeft, resp.headers.get("retry-after")),
        callerSignal,
      );
      return executeRequest(url, init, retriesLeft - 1);
    }

    return resp;
  }

  function throttledFetch(url: string, init?: RequestInit): Promise<Response> {
    // Deduplicate concurrent GET requests to the same URL
    const method = (init?.method ?? "GET").toUpperCase();
    if (dedupeGetRequests && method === "GET") {
      const existing = inflight.get(url);
      if (existing) {
        return existing.then(
          (response): Response => response.clone() as unknown as Response,
        );
      }
    }

    const promise = executeRequest(url, init, maxRetries).finally(() => {
      inflight.delete(url);
    });

    if (dedupeGetRequests && method === "GET") {
      inflight.set(url, promise);
    }

    return dedupeGetRequests && method === "GET"
      ? promise.then(
          (response): Response => response.clone() as unknown as Response,
        )
      : promise;
  }

  async function fetchJson<T = unknown>(
    url: string,
    init?: RequestInit,
  ): Promise<T> {
    const resp = await throttledFetch(url, init);
    if (!resp.ok) {
      throw new Error(
        resp.status === 429
          ? `Rate limited (${getHost(url)}) — try again later`
          : `HTTP ${resp.status} from ${getHost(url)}`,
      );
    }
    return resp.json() as Promise<T>;
  }

  return { fetch: throttledFetch, fetchJson };
}
