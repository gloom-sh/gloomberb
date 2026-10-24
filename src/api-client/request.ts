import { logFailure } from "../utils/log-failure";
import { httpFetch, isHttpFetchStreaming } from "../utils/http-transport";
import { OperationTimeoutError } from "../utils/async-deadline";
import {
  ApiRequestError,
  parseApiErrorCode,
  parseApiErrorDetails,
  parseApiErrorMessage,
  parseRetryAfterMs,
  type RevisionConflictError,
} from "./errors";
import {
  connectionHealth,
  GLOOM_CLOUD_FRED_CONNECTION_ID,
  GLOOM_CLOUD_HTTP_CONNECTION_ID,
  type ConnectionHealthRegistry,
} from "../core/connection-health";
import { SESSION_COOKIE_NAMES } from "./session-cookie";
import { asDataServiceFailure, DataServiceUnreachableError } from "../utils/network-failure";

/** The public Gloom Cloud API, which the web app's same-origin `/api` path forwards to. */
export const DEFAULT_API_URL = "https://api.gloom.sh";
/**
 * How long a request waits for the service to answer at all. Nothing back by
 * then, and nothing else answered meanwhile, is a hung connection: the request
 * fails as the data service being unreachable, as a refused one does.
 */
const DEFAULT_MARKET_REQUEST_TIMEOUT_MS = 10_000;
/** A search, which a command and a keystroke wait on, gives up sooner. */
const SEARCH_REQUEST_TIMEOUT_MS = 4_000;
/**
 * Once a request went unanswered, later ones wait this long for an answer,
 * until any answer comes back: a hung connection is not waited out in full by
 * every request a command or a pane makes after it.
 */
const UNREACHABLE_REQUEST_TIMEOUT_MS = 3_000;
/**
 * Right after a request hung with nothing back, the requests that follow it
 * (a fallback, the next step of a command) fail at once rather than each
 * waiting out a connection that just proved dead. Past this they try again.
 */
const HUNG_FAIL_FAST_MS = 5_000;
const DEFAULT_RESEARCH_REQUEST_TIMEOUT_MS = 45_000;
/** Requests outside market reads (saves, uploads, drafts) may take the server this long once it is known to answer. */
const DEFAULT_SERVICE_REQUEST_LIMIT_MS = 120_000;
const UPLOAD_REQUEST_LIMIT_MS = 300_000;
/**
 * How long the check that the service answers at all waits. It runs before
 * the answer deadline of a request allowed to take longer, so a slow server is
 * waited for and a dead connection is not.
 */
const SERVICE_PROBE_TIMEOUT_MS = 3_000;
const SERVICE_PROBE_PATH = "/health";
// Research may fill missing sections after a primary read; quote/history reads remain latency bounded.
const RESEARCH_MARKET_PATHS = new Set([
  "/market/dividends", "/market/short-interest", "/market/movers", "/market/trending",
  "/market/heatmap", "/market/earnings-calendar",
]);

/** When a request gives up: without any answer from the service, and in all. */
interface RequestDeadline {
  answerMs: number;
  limitMs: number;
  /** When to check that the service answers at all, for a request allowed past `answerMs`. */
  probeAtMs: number | null;
}
/** Local status for "this runtime cannot stream", never returned by the server. */
export const STREAMING_UNSUPPORTED_STATUS = 0;

type CloudApiResponse = Pick<Response, "ok" | "status" | "headers" | "text">;
type CloudApiFetchTransport = (
  url: string,
  init?: RequestInit,
) => Promise<CloudApiResponse>;
type CloudApiStreamFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;
type SessionCookieName = (typeof SESSION_COOKIE_NAMES)[number];

export interface CloudApiFetchTransportOptions {
  /**
   * Whether the transport resolves once headers arrive and exposes a live
   * `response.body`. The desktop transport proxies over RPC and returns the
   * whole payload as a string, so it must stay false: a caller that waits for
   * server-sent events on it would never see a first token.
   */
  streaming?: boolean;
  /**
   * A second transport for responses that must be read as they arrive, used
   * when the main one buffers. The desktop has exactly this shape: JSON goes
   * through a buffered RPC call, and a live body is forwarded chunk by chunk.
   */
  streamFetch?: CloudApiStreamFetch;
}

/**
 * One upload with its bytes and the headers the client built. A transport that
 * can watch the body go out (a browser XMLHttpRequest) reports `onProgress`
 * with the fraction sent; others never call it.
 */
export interface CloudApiUploadRequest {
  url: string;
  body: Blob | Uint8Array;
  headers: Headers;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}
type CloudApiUploadTransport = (request: CloudApiUploadRequest) => Promise<CloudApiResponse>;

let cloudApiFetchTransport: CloudApiFetchTransport = httpFetch;
let cloudApiUploadTransport: CloudApiUploadTransport | null = null;
let cloudApiTransportInstalled = false;
/** Counts installed transports, so what a client learned of one connection is not applied to the next. */
let cloudApiTransportGeneration = 0;
let cloudApiFetchStreaming = true;
let cloudApiStreamFetch: CloudApiStreamFetch | null = null;

export function setCloudApiFetchTransport(
  transport: CloudApiFetchTransport | null,
  options: CloudApiFetchTransportOptions = {},
): void {
  cloudApiFetchTransport = transport ?? httpFetch;
  cloudApiTransportInstalled = !!transport;
  cloudApiTransportGeneration += 1;
  cloudApiFetchStreaming = transport ? (options.streaming ?? false) : true;
  cloudApiStreamFetch = transport ? options.streamFetch ?? null : null;
}

/** Installs the transport uploads go through; without one they use the fetch transport. */
export function setCloudApiUploadTransport(transport: CloudApiUploadTransport | null): void {
  cloudApiUploadTransport = transport;
}

/**
 * The fetch to use for a response that must be read while it arrives, or null
 * when the installed transport buffers whole responses.
 */
function getCloudApiStreamFetch(): CloudApiStreamFetch | null {
  if (cloudApiTransportInstalled) {
    if (cloudApiStreamFetch) return cloudApiStreamFetch;
    // A transport that declares streaming returns a real Response.
    return cloudApiFetchStreaming
      ? (cloudApiFetchTransport as CloudApiStreamFetch)
      : null;
  }
  return isHttpFetchStreaming() ? httpFetch : null;
}

declare const __GLOOMBERB_API_URL__: string | undefined;

export function getCloudApiBaseUrl(): string {
  // Browser bundles have no `process`; the build replaces this with a literal.
  const bundled =
    typeof __GLOOMBERB_API_URL__ === "string" ? __GLOOMBERB_API_URL__ : "";
  if (bundled) {
    return typeof location !== "undefined" && bundled === location.origin
      ? `${bundled}/api`
      : bundled;
  }
  if (typeof process === "undefined") {
    return DEFAULT_API_URL;
  }
  return process.env.GLOOMBERB_API_URL ?? DEFAULT_API_URL;
}

/** How a sub-API calls the cloud: a path under the API base, resolving to the parsed body. */
export type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

/**
 * PUTs `body` with the expected revision as If-Match. On a 412 it reads back
 * what the server holds now (null if that read fails too) and throws it as a
 * `conflict`, whose revision falls back to the one after the expected one.
 */
export async function putWithRevision<T, Current extends { revision: number }>(
  request: CloudApiRequest,
  path: string,
  body: unknown,
  revision: {
    expected: number | undefined;
    loadCurrent: () => Promise<Current | null>;
    conflict: new (message: string, current: Current | null, currentRevision: number) => RevisionConflictError<Current>;
  },
): Promise<T> {
  try {
    return await request<T>(path, {
      method: "PUT",
      headers: revision.expected ? { "if-match": String(revision.expected) } : {},
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 412) throw error;
    const current = await revision.loadCurrent().catch(logFailure("cloud-request", "Current revision request failed", null));
    throw new revision.conflict(error.message, current, current?.revision ?? (revision.expected ?? 0) + 1);
  }
}

function throwIfRequestAborted(signal: AbortSignal | null | undefined): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

export class CloudApiRequestTransport {
  private sessionToken: string | null = null;
  private sessionCookieName: SessionCookieName | null = null;
  private websocketToken: string | null = null;
  private cookieSessionMode = false;
  private readonly fetchTransport: CloudApiFetchTransport | null;
  private readonly marketRequestTimeoutMs: number;
  private readonly researchRequestTimeoutMs: number;
  private readonly connectionHealth: ConnectionHealthRegistry;
  /** Answers received from the service, by any request: a request that sees this grow knows the connection works. */
  private answers = 0;
  /** The last request went unanswered (refused or hung) and nothing has answered since. */
  private unreachable = false;
  /** When a request last hung with nothing back, while nothing has answered since. */
  private hungAt: number | null = null;
  /** The installed transport the two above were learned on. */
  private connectionGeneration = cloudApiTransportGeneration;
  private probe: Promise<void> | null = null;

  readonly baseUrl = getCloudApiBaseUrl();

  constructor(
    options: {
      fetchTransport?: CloudApiFetchTransport;
      marketRequestTimeoutMs?: number;
      connectionHealth?: ConnectionHealthRegistry;
    } = {},
  ) {
    this.fetchTransport = options.fetchTransport ?? null;
    this.marketRequestTimeoutMs =
      options.marketRequestTimeoutMs ?? DEFAULT_MARKET_REQUEST_TIMEOUT_MS;
    this.researchRequestTimeoutMs = options.marketRequestTimeoutMs ?? DEFAULT_RESEARCH_REQUEST_TIMEOUT_MS;
    this.connectionHealth = options.connectionHealth ?? connectionHealth;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  getWebSocketToken(): string | null {
    return this.websocketToken;
  }

  hasSessionCredential(): boolean {
    return this.cookieSessionMode || !!this.sessionToken;
  }

  setCookieSessionMode(enabled: boolean): void {
    this.cookieSessionMode = enabled;
  }

  setSessionToken(token: string | null): void {
    if (this.sessionToken !== token) {
      this.sessionCookieName = null;
    }
    this.sessionToken = token;
    if (!token) {
      this.websocketToken = null;
    }
  }

  setWebSocketToken(token: string | null): void {
    this.websocketToken = token;
  }

  getSocketAuthToken(): string | null {
    return this.websocketToken || this.sessionToken;
  }

  clearWebSocketTokenForFallback(): boolean {
    if (!this.websocketToken || !this.sessionToken) return false;
    this.websocketToken = null;
    return true;
  }

  /** False when this transport buffers whole responses, e.g. the desktop view. */
  isStreamingSupported(): boolean {
    return !this.fetchTransport && !!getCloudApiStreamFetch();
  }

  /**
   * Opens a response that the caller reads incrementally. Unlike `request`,
   * nothing is buffered or JSON-parsed here, so the body stays a live stream.
   */
  async openStream(path: string, options: RequestInit = {}): Promise<Response> {
    throwIfRequestAborted(options.signal);
    const streamFetch = this.fetchTransport ? null : getCloudApiStreamFetch();
    if (!streamFetch) {
      throw new ApiRequestError(
        "This client cannot read streaming responses.",
        STREAMING_UNSUPPORTED_STATUS,
      );
    }
    const headers = new Headers(options.headers);
    if (
      !headers.has("Content-Type") &&
      options.method &&
      options.method !== "GET"
    ) {
      headers.set("Content-Type", "application/json");
    }
    if (!headers.has("Accept")) headers.set("Accept", "text/event-stream");
    this.setSessionCookieHeader(headers);
    headers.set("Origin", this.baseUrl);

    const operation = `${options.method ?? "GET"} ${path.split("?")[0]}`;
    return this.connectionHealth.track(
      GLOOM_CLOUD_HTTP_CONNECTION_ID,
      operation,
      async () => {
        const response = await this.reachService(() => streamFetch(`${this.baseUrl}${path}`, {
          ...options,
          headers,
          credentials: "include",
        }), options.signal);
        throwIfRequestAborted(options.signal);
        if (!response.ok) {
          const text = await response.text().catch(logFailure("cloud-request", "Error response body read failed", ""));
          throw new ApiRequestError(
            parseApiErrorMessage(text),
            response.status,
            parseRetryAfterMs(response.headers.get("Retry-After")),
            parseApiErrorCode(text),
          );
        }
        return response;
      },
    );
  }

  async request<T>(path: string, options?: RequestInit, canApplySession: () => boolean = () => true): Promise<T> {
    return this.withDeadline(path, this.deadlineFor(path), options?.signal, (signal) => this.performRequest<T>(path, {
      ...options,
      signal,
    }, canApplySession));
  }

  /**
   * Every request's deadline. A market read waits about ten seconds (a search
   * four), research and requests outside market data longer once the service
   * is known to answer. After a request went unanswered, the next ones wait
   * only briefly until something answers again.
   */
  private deadlineFor(path: string, limitMs?: number): RequestDeadline {
    this.forgetOtherTransport();
    const pathname = path.split("?")[0]!;
    const market = pathname.startsWith("/market/");
    const answerMs = pathname === "/market/search"
      ? Math.min(this.marketRequestTimeoutMs, SEARCH_REQUEST_TIMEOUT_MS)
      : this.marketRequestTimeoutMs;
    const limit = limitMs ?? (!market ? DEFAULT_SERVICE_REQUEST_LIMIT_MS
      : RESEARCH_MARKET_PATHS.has(pathname) ? this.researchRequestTimeoutMs : answerMs);
    if (this.unreachable) {
      const shortened = Math.min(answerMs, UNREACHABLE_REQUEST_TIMEOUT_MS);
      return { answerMs: shortened, limitMs: limit === answerMs ? shortened : limit, probeAtMs: null };
    }
    return {
      answerMs,
      limitMs: limit,
      probeAtMs: limit > answerMs && answerMs > SERVICE_PROBE_TIMEOUT_MS ? answerMs - SERVICE_PROBE_TIMEOUT_MS : null,
    };
  }

  /**
   * Runs one request under its deadline. Without an answer from the service by
   * `answerMs` (from this request or any other), the connection is taken as
   * hung: the request is aborted and fails as the data service being
   * unreachable, as a refused connection does. A service that answers but is
   * slow gets until `limitMs`, then the request times out. A caller's abort
   * stays an abort.
   */
  private async withDeadline<T>(
    path: string,
    deadline: RequestDeadline,
    callerSignal: AbortSignal | null | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const answersAtStart = this.answers;
    const answered = () => this.answers > answersAtStart;
    const what = path.startsWith("/market/") ? "Cloud market request" : "Cloud request";
    const timedOut = (ms: number) => new OperationTimeoutError(`${what} timed out after ${ms}ms: ${path.split("?")[0]}`);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    if (this.hungAt != null && Date.now() - this.hungAt < HUNG_FAIL_FAST_MS && !controller.signal.aborted) {
      callerSignal?.removeEventListener("abort", abortFromCaller);
      throw new DataServiceUnreachableError(new OperationTimeoutError(`${what} not sent: the last one got no answer: ${path.split("?")[0]}`));
    }
    try {
      const work = run(controller.signal);
      return await new Promise<T>((resolve, reject) => {
        const fail = (error: Error) => {
          reject(error);
          controller.abort(error);
        };
        work.then(resolve, reject);
        if (deadline.probeAtMs != null) {
          timers.push(setTimeout(() => {
            if (!answered()) this.checkServiceAnswers();
          }, deadline.probeAtMs));
        }
        timers.push(setTimeout(() => {
          // The caller gave up first: its abort settles the request, and says nothing of the connection.
          if (callerSignal?.aborted) return;
          if (!answered()) {
            this.unreachable = true;
            this.hungAt = Date.now();
            fail(new DataServiceUnreachableError(timedOut(deadline.answerMs)));
          } else if (deadline.limitMs > deadline.answerMs) {
            timers.push(setTimeout(() => fail(timedOut(deadline.limitMs)), deadline.limitMs - deadline.answerMs));
          } else {
            fail(timedOut(deadline.answerMs));
          }
        }, deadline.answerMs));
      });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /**
   * Sends one request, saying the same thing whichever fetch failed to connect
   * (Bun's "Unable to connect", a browser's "Failed to fetch", a refused proxy):
   * every command, pane and status line then reads "Gloom couldn't reach its
   * data service", and code that falls back to a saved copy can tell it apart.
   * A caller's abort stays an abort. An answer of any status says the
   * connection works, for the deadlines of the requests beside it.
   */
  private async reachService<R>(fetch: () => Promise<R>, signal: AbortSignal | null | undefined): Promise<R> {
    let response: R;
    try {
      response = await fetch();
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = asDataServiceFailure(error);
      if (failure instanceof DataServiceUnreachableError) this.unreachable = true;
      throw failure;
    }
    this.recordAnswer();
    return response;
  }

  /** A new transport installed is a new connection: what failed on the last one says nothing about it. */
  private forgetOtherTransport(): void {
    if (this.fetchTransport || this.connectionGeneration === cloudApiTransportGeneration) return;
    this.connectionGeneration = cloudApiTransportGeneration;
    this.unreachable = false;
    this.hungAt = null;
  }

  /** Something came back from the service: the connection works. */
  private recordAnswer(): void {
    this.answers += 1;
    this.unreachable = false;
    this.hungAt = null;
  }

  /**
   * Asks the service for anything at all, once at a time, so a request that
   * may take long can tell a slow server (which answers this) from a dead
   * connection (which does not). Any status counts as an answer.
   */
  private checkServiceAnswers(): void {
    if (this.probe) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SERVICE_PROBE_TIMEOUT_MS);
    this.probe = (this.fetchTransport ?? cloudApiFetchTransport)(`${this.baseUrl}${SERVICE_PROBE_PATH}`, { signal: controller.signal })
      .then(() => this.recordAnswer(), () => {
        // Intentional ignore: an unanswered check only leaves the request it guards to its own deadline.
      })
      .finally(() => {
        clearTimeout(timer);
        this.probe = null;
      });
  }

  /**
   * POSTs raw bytes, such as an image, and parses the JSON answer like
   * `request`. Progress is reported where the installed upload transport can
   * see the body go out.
   */
  async upload<T>(
    path: string,
    body: Blob | Uint8Array,
    options: {
      contentType: string;
      headers?: HeadersInit;
      signal?: AbortSignal;
      onProgress?: (fraction: number) => void;
    },
  ): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", options.contentType);
    const uploadTransport = this.fetchTransport ? null : cloudApiUploadTransport;
    const send: CloudApiFetchTransport | undefined = uploadTransport
      ? (url, init) => uploadTransport({
        url,
        body,
        headers: new Headers(init?.headers),
        signal: init?.signal ?? options.signal,
        onProgress: options.onProgress,
      })
      : undefined;
    return this.withDeadline(path, this.deadlineFor(path, UPLOAD_REQUEST_LIMIT_MS), options.signal, (signal) => this.performRequest<T>(path, {
      method: "POST",
      headers,
      // Typed arrays are valid fetch bodies; RequestInit's DOM typing lags behind.
      body: body as BodyInit,
      signal,
    }, () => true, send));
  }

  private async performRequest<T>(
    path: string,
    options: RequestInit | undefined,
    canApplySession: () => boolean,
    send?: CloudApiFetchTransport,
  ): Promise<T> {
    throwIfRequestAborted(options?.signal);
    const headers = new Headers(options?.headers);
    if (
      !headers.has("Content-Type") &&
      options?.method &&
      options.method !== "GET"
    ) {
      headers.set("Content-Type", "application/json");
    }
    this.setSessionCookieHeader(headers);
    const sessionTokenAtRequestStart = this.sessionToken;
    headers.set("Origin", this.baseUrl);

    const operation = `${options?.method ?? "GET"} ${path.split("?")[0]}`;
    const request = async () => {
      const res = await this.reachService(() => (send ?? this.fetchTransport ?? cloudApiFetchTransport)(
        `${this.baseUrl}${path}`,
        {
          ...options,
          headers,
          credentials: "include",
        },
      ), options?.signal);
      throwIfRequestAborted(options?.signal);
      const ownsCredential = canApplySession() && this.sessionToken === sessionTokenAtRequestStart;
      if (ownsCredential) this.extractSessionCookie(res);
      const sessionTokenAfterHeaders = this.sessionToken;
      const text = await res.text();
      throwIfRequestAborted(options?.signal);

      if (!res.ok) {
        const msg = parseApiErrorMessage(text);
        throw new ApiRequestError(
          msg,
          res.status,
          parseRetryAfterMs(res.headers.get("Retry-After")),
          parseApiErrorCode(text),
          parseApiErrorDetails(text),
        );
      }

      if (!text) return undefined as T;
      const parsed = JSON.parse(text) as T & { token?: string };
      if (ownsCredential && canApplySession() && this.sessionToken === sessionTokenAfterHeaders
        && typeof parsed?.token === "string" && parsed.token.length > 0) {
        this.websocketToken = parsed.token;
      }
      return parsed as T;
    };
    // Crash reports, usage counts and command-search reports are background
    // traffic: a rate-limited, timed-out or missing one must not show up as a
    // Cloud outage in the connections pane. Nor must the map's probe for geo
    // layers, which a server without them answers with 404, or a ticker
    // change lookup: a note beside a quote, never one of the refused market
    // requests a lookup of many symbols waits out and retries. Nor the
    // tickers beside a list of organization names, which say so in place,
    // or a 13F filer's EDGAR filing list, whose report says it went unchecked,
    // or a company's other listings, beside a list check that still answers
    // for the listing itself. Nor the batched searches and ticker changes a
    // list of symbols starts with: a service without them answers 404, and whatever they leave
    // unanswered is looked up one symbol at a time, which is tracked.
    if (
      path.startsWith("/telemetry/")
      || path === "/assist/searches"
      || path === "/cloud/geo/layers"
      || path.startsWith("/cloud/sec/13f/filer?")
      || path.startsWith("/market/ticker-changes?")
      || path.startsWith("/market/issuer-listings?")
      || path === "/market/ticker-changes/batch"
      || path === "/market/search/batch"
      || path === "/market/organization-tickers"
    ) return request();
    return this.connectionHealth.track(
      GLOOM_CLOUD_HTTP_CONNECTION_ID,
      operation,
      () =>
        path.startsWith("/cloud/econ/series/")
          ? this.connectionHealth.track(
              GLOOM_CLOUD_FRED_CONNECTION_ID,
              operation,
              request,
            )
          : request(),
    );
  }

  private extractSessionCookie(res: CloudApiResponse): void {
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const fallbackHeader = res.headers.get("set-cookie");
    if (fallbackHeader) {
      setCookie.push(fallbackHeader);
    }
    for (const cookie of setCookie) {
      for (const cookieName of SESSION_COOKIE_NAMES) {
        const escapedCookieName = cookieName.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const match = cookie.match(new RegExp(`${escapedCookieName}=([^;]+)`));
        if (!match) continue;
        this.sessionToken = match[1] ?? null;
        this.sessionCookieName = cookieName;
        return;
      }
    }
  }

  private buildSessionCookieHeader(): string | null {
    if (!this.sessionToken) return null;
    const cookieNames = this.sessionCookieName
      ? [this.sessionCookieName]
      : SESSION_COOKIE_NAMES;
    return cookieNames
      .map((cookieName) => `${cookieName}=${this.sessionToken}`)
      .join("; ");
  }

  private setSessionCookieHeader(headers: Headers): void {
    const cookieHeader = this.buildSessionCookieHeader();
    if (cookieHeader) {
      headers.set("Cookie", cookieHeader);
    }
  }
}
