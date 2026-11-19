import { apiClient, setCloudApiFetchTransport, setCloudApiUploadTransport } from "../../api-client";
import type { CloudApiUploadRequest } from "../../api-client/request";
import { settleWithin, signalWithTimeout } from "../../utils/async-deadline";
import { setHttpFetchTransport } from "../../utils/http-transport";
import { createBrowserHttpProxyTransport } from "./http-proxy-transport";
import { NO_SESSION_COOKIE, SESSION_BINDING_HEADER, SESSION_BINDING_META, SESSION_COOKIE_NAMES } from "../../api-client/session-cookie";
import { logFailure } from "../../utils/log-failure";
import { readBrowserSessionUser, rememberBrowserSessionUser } from "./session-cache";
import type { AuthUser } from "../../api-client";

let boundAccount: { binding: string; id: string } | null = null;
let sessionRead = 0;
const SESSION_MUTATIONS = new Set([
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-up/email",
  "POST /api/auth/one-tap/callback",
  "POST /api/auth/sign-out",
  "POST /api/auth/change-password",
  "DELETE /api/account",
]);
const SESSION_READ_TIMEOUT_MS = 15_000;

function plantBrowserSessionCookies(cookieHeader: string): void {
  if (typeof document === "undefined") return;
  const secure = typeof location !== "undefined" && location.protocol === "https:";
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!(SESSION_COOKIE_NAMES as readonly string[]).includes(name) || !value) continue;
    const useSecure = secure || name.startsWith("__Secure-");
    document.cookie = `${name}=${value}; Path=/; SameSite=Lax${useSecure ? "; Secure" : ""}`;
  }
}

export async function browserCredentialedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookieHeader = headers.get("Cookie");
  if (cookieHeader) plantBrowserSessionCookies(cookieHeader);
  // These are controlled by the browser. Desktop transports may set them, but
  // carrying them into fetch would either fail or misrepresent the web origin.
  headers.delete("Cookie");
  headers.delete("Origin");
  // Reads skip the HTTP cache. Chromium lets only one request per URL use the
  // cache at a time, so the same read from a second tab, or a second pane,
  // waits for the first to finish and then goes to the network anyway: three
  // tabs opened together waited seconds per request that way.
  const method = (init.method ?? "GET").toUpperCase();
  const read = method === "GET" && init.cache === undefined;
  const pathname = typeof location !== "undefined" && url.startsWith(`${location.origin}/`)
    ? new URL(url).pathname : "";
  const authRoute = pathname.startsWith("/api/auth/");
  const sessionRoute = pathname === "/api/auth/get-session" && method === "GET";
  if (SESSION_MUTATIONS.has(`${method} ${pathname}`)) sessionRead += 1;
  const request = sessionRoute ? ++sessionRead : sessionRead;
  const signal = sessionRoute ? signalWithTimeout(init.signal ?? undefined, SESSION_READ_TIMEOUT_MS) : init.signal;
  const credentials = !authRoute && !cookieHeader && apiClient.isCookieIdentityUnavailable() ? "omit" : "include";
  const response = await fetch(url, { ...init, headers, signal, credentials, ...(read ? { cache: "no-store" as const } : {}) });
  const binding = response.headers.get(SESSION_BINDING_HEADER);
  if (sessionRoute && response.url === url && request === sessionRead && !signal?.aborted) {
    try {
      if (response.status === 401) {
        boundAccount = null;
        rememberBrowserSessionUser(localStorage, NO_SESSION_COOKIE, null);
      } else if (binding && response.ok) {
        const result = await response.clone().json() as { user?: AuthUser } | null;
        if (request === sessionRead && !signal?.aborted) {
          boundAccount = result?.user && binding !== NO_SESSION_COOKIE ? { binding, id: result.user.id } : null;
          rememberBrowserSessionUser(localStorage, binding, result?.user ?? null);
        }
      }
    } catch {
      // Intentional ignore: an unavailable display cache must not affect authentication.
    }
  }
  return response;
}

function parseResponseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    try {
      headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    } catch {
      // Intentional ignore: a header the Headers class refuses is not one the client reads.
    }
  }
  return headers;
}

/**
 * Uploads through XMLHttpRequest, the one browser API that reports how much of
 * a request body has gone out, so an image upload can show its progress.
 */
function browserXhrUpload(request: CloudApiUploadRequest): Promise<Response> {
  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader) plantBrowserSessionCookies(cookieHeader);
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", request.url);
    xhr.withCredentials = true;
    request.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower === "cookie" || lower === "origin") return;
      xhr.setRequestHeader(name, value);
    });
    const abort = () => xhr.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    const settle = () => request.signal?.removeEventListener("abort", abort);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) request.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      settle();
      const text = xhr.responseText;
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        statusText: xhr.statusText,
        headers: parseResponseHeaders(xhr.getAllResponseHeaders()),
        text: async () => text,
      } as Response);
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError("The upload could not reach the server."));
    };
    xhr.onabort = () => {
      settle();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    xhr.send(request.body as XMLHttpRequestBodyInit);
  });
}

export function installBrowserFetchTransports(): void {
  apiClient.setCookieSessionMode(true);
  apiClient.subscribeCurrentUser(() => {
    if (!boundAccount) return;
    const user = apiClient.getCurrentUser();
    const matchingUser = user?.id === boundAccount.id ? user : null;
    if (matchingUser && !apiClient.getConfirmedDisplayUser()) return;
    try {
      rememberBrowserSessionUser(localStorage, boundAccount.binding, matchingUser);
    } catch { /* Intentional ignore: browser display storage may be unavailable. */ }
    if (!matchingUser) boundAccount = null;
  });
  // Native fetch, so a response body can be read while it arrives.
  setCloudApiFetchTransport(browserCredentialedFetch, { streaming: true });
  setCloudApiUploadTransport(browserXhrUpload);
  // Plugin requests to a host on the proxy allowlist go through the worker,
  // which can reach APIs that send no CORS headers. Those come back buffered,
  // but nothing on the allowlist streams; every other host is a direct fetch
  // exactly as before, and that path does.
  setHttpFetchTransport(createBrowserHttpProxyTransport(), { streaming: true });
}

export async function restoreBrowserCloudSession(budgetMs = 5_000): Promise<void> {
  const binding = document.querySelector<HTMLMetaElement>(`meta[name="${SESSION_BINDING_META}"]`)?.content ?? null;
  if (binding !== NO_SESSION_COOKIE) apiClient.waitForCookieIdentity();
  let cachedUser = null;
  try { cachedUser = readBrowserSessionUser(localStorage, binding); } catch { /* Intentional ignore: browser storage may be blocked. */ }
  if (cachedUser) {
    apiClient.restoreCachedUser(cachedUser, false);
    apiClient.getSession().catch(logFailure("web-session", "Could not verify the restored session"));
    return;
  }
  await settleWithin(apiClient.getSession(), budgetMs);
  apiClient.finishCookieIdentityBoot();
}
