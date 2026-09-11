import { setCloudApiFetchTransport } from "../../../api-client";
import { createProxyResponseHeaders } from "../../../utils/http-proxy-response";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import type { DesktopHttpFetchResponse } from "../shared/protocol";
import { backendRequest } from "./backend-rpc";

const CLOUD_MARKET_HTTP_TIMEOUT_MS = 10_000;

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[key] = value;
    }
    return normalized;
  }
  return { ...headers };
}

function createAbortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

async function serializeBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  return new Response(body).text();
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

async function electrobunHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (init?.signal?.aborted) {
    throw createAbortError();
  }

  const requestPromise = requestBackendHttpFetch(url, init);

  const response = await withAbort(requestPromise, init?.signal);
  const headers = createProxyResponseHeaders(response.headers, response.setCookie);
  const fetchResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  Object.defineProperty(fetchResponse, "headers", {
    value: headers,
    configurable: true,
  });
  return fetchResponse;
}

async function requestBackendHttpFetch(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<DesktopHttpFetchResponse> {
  return backendRequest("http.fetch", {
    url,
    init: {
      method: init?.method,
      headers: normalizeHeaders(init?.headers),
      body: await serializeBody(init?.body),
      redirect: init?.redirect,
      timeoutMs,
    },
  });
}

async function electrobunCloudApiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (init?.signal?.aborted) {
    throw createAbortError();
  }
  const timeoutMs = new URL(url).pathname.startsWith("/market/")
    ? CLOUD_MARKET_HTTP_TIMEOUT_MS
    : undefined;
  const response = await withAbort(requestBackendHttpFetch(url, init, timeoutMs), init?.signal);

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.statusText,
    headers: createProxyResponseHeaders(response.headers, response.setCookie),
    text: async () => response.body,
  } as Response;
}

export function installElectrobunHttpFetchTransport(): void {
  setHttpFetchTransport(electrobunHttpFetch);
}

export function installElectrobunCloudApiFetchTransport(): void {
  setCloudApiFetchTransport(electrobunCloudApiFetch);
}
