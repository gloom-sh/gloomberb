import { setCloudApiFetchTransport } from "../../../api-client";
import { createProxyResponseHeaders } from "../../../utils/http-proxy-response";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import type { DesktopHttpFetchResponse } from "../shared/protocol";
import { backendRequest, onHttpStreamChunk } from "./backend-rpc";

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

let nextStreamId = 1;

async function drainStreamText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Opens a Gloom Cloud response the caller reads as it arrives, such as the
 * Ask Gloom turn stream.
 *
 * The buffered transport above cannot carry one: it resolves only once the
 * whole body is in, which for server-sent events is never. The Bun process
 * keeps the body open instead and forwards it as `http.stream.chunk`
 * messages, reassembled here into a `ReadableStream`.
 */
async function electrobunCloudApiStreamFetch(url: string, init?: RequestInit): Promise<Response> {
  if (init?.signal?.aborted) {
    throw createAbortError();
  }

  const streamId = `cloud-stream:${nextStreamId++}`;
  const encoder = new TextEncoder();
  let stopListening: (() => void) | null = null;
  // Assigned by `start`, which the ReadableStream constructor runs before it
  // returns, so every use below already has it.
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;

  const releaseListeners = () => {
    if (settled) return false;
    settled = true;
    stopListening?.();
    init?.signal?.removeEventListener("abort", onAbort);
    return true;
  };
  // Only a stream still running is worth cancelling; one that already ended
  // has nothing left in the Bun process to stop.
  const cancelUpstream = () => {
    if (!releaseListeners()) return;
    void backendRequest("http.stream.cancel", { streamId }).catch(() => {});
  };
  function onAbort(): void {
    cancelUpstream();
    controller.error(createAbortError());
  }

  // `start` runs synchronously, so the controller exists before the first
  // chunk can be delivered.
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      cancelUpstream();
    },
  });

  // Subscribed before opening: the Bun process forwards as soon as the head
  // is back, and a listener attached later would miss the first tokens.
  stopListening = onHttpStreamChunk(streamId, (message) => {
    if (settled) return;
    if (typeof message.chunk === "string" && message.chunk) {
      controller.enqueue(encoder.encode(message.chunk));
    }
    if (message.error) {
      releaseListeners();
      controller.error(new Error(message.error));
      return;
    }
    if (message.done) {
      releaseListeners();
      controller.close();
    }
  });
  init?.signal?.addEventListener("abort", onAbort, { once: true });

  const requestBody = await serializeBody(init?.body);
  let head;
  try {
    head = await backendRequest("http.stream.open", {
      streamId,
      url,
      init: {
        ...(init?.method ? { method: init.method } : {}),
        headers: normalizeHeaders(init?.headers),
        ...(requestBody === undefined ? {} : { body: requestBody }),
      },
    });
  } catch (error) {
    releaseListeners();
    controller.close();
    throw error;
  }

  return {
    ok: head.status >= 200 && head.status < 300,
    status: head.status,
    statusText: head.statusText,
    headers: createProxyResponseHeaders(head.headers, head.setCookie),
    body,
    text: () => drainStreamText(body),
  } as unknown as Response;
}

export function installElectrobunHttpFetchTransport(): void {
  setHttpFetchTransport(electrobunHttpFetch);
}

export function installElectrobunCloudApiFetchTransport(): void {
  setCloudApiFetchTransport(electrobunCloudApiFetch, {
    streamFetch: electrobunCloudApiStreamFetch,
  });
}
