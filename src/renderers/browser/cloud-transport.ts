import { apiClient, setCloudApiFetchTransport, setCloudApiUploadTransport } from "../../api-client";
import type { CloudApiUploadRequest } from "../../api-client/request";
import { settleWithin } from "../../utils/async-deadline";
import { setHttpFetchTransport } from "../../utils/http-transport";
import { createBrowserHttpProxyTransport } from "./http-proxy-transport";
import { SESSION_COOKIE_NAMES } from "../../api-client/session-cookie";

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

export function browserCredentialedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookieHeader = headers.get("Cookie");
  if (cookieHeader) plantBrowserSessionCookies(cookieHeader);
  // These are controlled by the browser. Desktop transports may set them, but
  // carrying them into fetch would either fail or misrepresent the web origin.
  headers.delete("Cookie");
  headers.delete("Origin");
  return fetch(url, { ...init, headers, credentials: "include" });
}

function parseResponseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    try {
      headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    } catch {
      // A header the Headers class refuses is not one the client reads.
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
  await settleWithin(apiClient.getSession(), budgetMs);
}
