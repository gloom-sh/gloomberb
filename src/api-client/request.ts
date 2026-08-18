import { httpFetch } from "../utils/http-transport";
import { withDeadline } from "../utils/async-deadline";
import { ApiRequestError, parseApiErrorMessage } from "./errors";
import {
  connectionHealth,
  GLOOM_CLOUD_FRED_CONNECTION_ID,
  GLOOM_CLOUD_HTTP_CONNECTION_ID,
  type ConnectionHealthRegistry,
} from "../core/connection-health";

const DEFAULT_API_URL = "https://api.gloom.sh";
const DEFAULT_MARKET_REQUEST_TIMEOUT_MS = 10_000;
const SESSION_COOKIE_NAMES = ["__Secure-gloomberb.session_token", "gloomberb.session_token"] as const;

type CloudApiResponse = Pick<Response, "ok" | "status" | "headers" | "text">;
type CloudApiFetchTransport = (url: string, init?: RequestInit) => Promise<CloudApiResponse>;
type SessionCookieName = (typeof SESSION_COOKIE_NAMES)[number];

let cloudApiFetchTransport: CloudApiFetchTransport = httpFetch;

export function setCloudApiFetchTransport(transport: CloudApiFetchTransport | null): void {
  cloudApiFetchTransport = transport ?? httpFetch;
}

declare const __GLOOMBERB_API_URL__: string | undefined;

function getCloudApiBaseUrl(): string {
  // Browser bundles have no `process`; the build replaces this with a literal.
  const bundled = typeof __GLOOMBERB_API_URL__ === "string" ? __GLOOMBERB_API_URL__ : "";
  if (bundled) return bundled;
  if (typeof process === "undefined") {
    return DEFAULT_API_URL;
  }
  return process.env.GLOOMBERB_API_URL ?? DEFAULT_API_URL;
}

function throwIfRequestAborted(signal: AbortSignal | null | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export class CloudApiRequestTransport {
  private sessionToken: string | null = null;
  private sessionCookieName: SessionCookieName | null = null;
  private websocketToken: string | null = null;
  private readonly fetchTransport: CloudApiFetchTransport | null;
  private readonly marketRequestTimeoutMs: number;
  private readonly connectionHealth: ConnectionHealthRegistry;

  readonly baseUrl = getCloudApiBaseUrl();

  constructor(options: {
    fetchTransport?: CloudApiFetchTransport;
    marketRequestTimeoutMs?: number;
    connectionHealth?: ConnectionHealthRegistry;
  } = {}) {
    this.fetchTransport = options.fetchTransport ?? null;
    this.marketRequestTimeoutMs = options.marketRequestTimeoutMs ?? DEFAULT_MARKET_REQUEST_TIMEOUT_MS;
    this.connectionHealth = options.connectionHealth ?? connectionHealth;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  getWebSocketToken(): string | null {
    return this.websocketToken;
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

  async request<T>(path: string, options?: RequestInit): Promise<T> {
    if (!path.startsWith("/market/")) {
      return this.performRequest<T>(path, options);
    }

    const controller = new AbortController();
    const callerSignal = options?.signal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      const request = this.performRequest<T>(path, {
        ...options,
        signal: controller.signal,
      });
      return await withDeadline(
        request,
        this.marketRequestTimeoutMs,
        `Cloud market request timed out after ${this.marketRequestTimeoutMs}ms: ${path}`,
        (error) => controller.abort(error),
      );
    } finally {
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async performRequest<T>(path: string, options?: RequestInit): Promise<T> {
    throwIfRequestAborted(options?.signal);
    const headers = new Headers(options?.headers);
    if (!headers.has("Content-Type") && options?.method && options.method !== "GET") {
      headers.set("Content-Type", "application/json");
    }
    this.setSessionCookieHeader(headers);
    headers.set("Origin", this.baseUrl);

    const operation = `${options?.method ?? "GET"} ${path.split("?")[0]}`;
    const request = async () => {
      const res = await (this.fetchTransport ?? cloudApiFetchTransport)(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        credentials: "include",
      });
      throwIfRequestAborted(options?.signal);
      this.extractSessionCookie(res);
      const text = await res.text();
      throwIfRequestAborted(options?.signal);

      if (!res.ok) {
        const msg = parseApiErrorMessage(text);
        throw new ApiRequestError(msg, res.status);
      }

      if (!text) return undefined as T;
      const parsed = JSON.parse(text) as T & { token?: string };
      if (typeof parsed?.token === "string" && parsed.token.length > 0) {
        this.websocketToken = parsed.token;
      }
      return parsed as T;
    };
    return this.connectionHealth.track(
      GLOOM_CLOUD_HTTP_CONNECTION_ID,
      operation,
      () => path.startsWith("/cloud/econ/series/")
        ? this.connectionHealth.track(GLOOM_CLOUD_FRED_CONNECTION_ID, operation, request)
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
        const escapedCookieName = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const cookieNames = this.sessionCookieName ? [this.sessionCookieName] : SESSION_COOKIE_NAMES;
    return cookieNames.map((cookieName) => `${cookieName}=${this.sessionToken}`).join("; ");
  }

  private setSessionCookieHeader(headers: Headers): void {
    const cookieHeader = this.buildSessionCookieHeader();
    if (cookieHeader) {
      headers.set("Cookie", cookieHeader);
    }
  }
}
