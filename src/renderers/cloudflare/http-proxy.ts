/**
 * Server half of the plugin HTTP transport for the hosted web app.
 *
 * The terminal reaches third-party APIs directly, and the desktop forwards
 * them to its Bun process (`http.fetch`). The web build has neither: it runs
 * on a real origin, so a plugin's request is subject to CORS, and it cannot
 * set `Cookie` because browsers own that header. This route is the web's
 * equivalent of the desktop backend, using the same envelope so the client
 * side of both transports behaves identically.
 *
 * The desktop version deliberately has no allowlist: it runs on the user's own
 * machine, reaching only what that machine could already reach. This one is
 * on the public internet, so an unrestricted copy would be an open proxy
 * running on our bandwidth and our IP reputation. Everything below exists to
 * keep that from happening.
 */
import {
  readRequestInit,
  toResponseHead,
  type HttpProxyResponseEnvelope,
  type ProxiedRequestInit,
} from "../../utils/http-proxy-response";
import { isProxiedHost, PROXY_ALLOWED_HOSTS } from "../../utils/plugin-proxy-hosts";
import type { ProxySessionGate } from "./proxy-session";

const PROXY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Set by the caller's browser or meaningful only to the hop it came from. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Dropped when a redirect leaves the origin the plugin set them for. */
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie", "proxy-authorization"];
/** Dropped when a redirect turns the request into a bodiless GET. */
const REQUEST_BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type"];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Plugin request bodies are small JSON; anything near this is not one. */
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Rejects anything that is not a plain https host on the allowlist.
 *
 * IP literals are refused outright rather than range-checked: no allowlisted
 * host needs one, and it removes the entire class of "does this address point
 * somewhere internal" bugs, including the decimal and IPv6-mapped spellings
 * that defeat naive checks.
 */
export function validateProxyTarget(
  rawUrl: unknown,
  hosts: readonly string[] = PROXY_ALLOWED_HOSTS,
): { url: URL } | { error: string; status: number } {
  if (typeof rawUrl !== "string" || rawUrl.length > 2_048) {
    return { error: "A target URL is required.", status: 400 };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "The target URL is not valid.", status: 400 };
  }
  if (url.protocol !== "https:") {
    return { error: "Only https targets are allowed.", status: 400 };
  }
  if (url.username || url.password) {
    return { error: "Credentials in the URL are not allowed.", status: 400 };
  }
  if (url.port && url.port !== "443") {
    return { error: "Only the default https port is allowed.", status: 400 };
  }
  if (/^\d|^\[|:/.test(url.hostname) || url.hostname === "localhost") {
    return { error: "The target host is not allowed.", status: 403 };
  }
  if (!isProxiedHost(url.hostname, hosts)) {
    return { error: "The target host is not on the plugin allowlist.", status: 403 };
  }
  return { url };
}

function upstreamHeaders(raw: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    try {
      headers.set(name, value);
    } catch {
      // A header name the runtime refuses is dropped rather than failing the
      // whole request, matching how a browser treats an unsettable header.
    }
  }
  return headers;
}

function proxyError(message: string, status: number, headers: Record<string, string> = {}): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store", ...headers } });
}

/**
 * Reads a body as text, giving up once it passes `maxBytes`. Returns null when
 * it was too large, after cancelling the stream so the rest is never pulled.
 */
async function readTextWithin(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

type UpstreamResult = { response: Response } | { error: string; status: number };

/**
 * Follows redirects one hop at a time instead of letting `fetch` do it, so
 * every `Location` passes the same allowlist check as the first URL. An
 * allowlisted host that redirects elsewhere (an open redirect, a moved API)
 * would otherwise carry the request to any host on the internet.
 *
 * Method and header handling mirror the Fetch spec: 303, and 301/302 after a
 * POST, become a bodiless GET; credentials the plugin set are dropped when the
 * redirect leaves the origin they were meant for.
 */
async function fetchWithinAllowlist(
  first: URL,
  init: ProxiedRequestInit,
  fetchUpstream: typeof fetch,
  hosts: readonly string[],
  signal: AbortSignal,
): Promise<UpstreamResult> {
  const headers = upstreamHeaders(init.headers);
  const mode = init.redirect ?? "follow";
  let url = first;
  let method = init.method;
  let body = init.body;

  for (let followed = 0; ; followed += 1) {
    const response = await fetchUpstream(url, { method, headers, body, redirect: "manual", signal });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    // "manual" hands the redirect back to the plugin. If it follows it, that
    // comes back through here as a new request and is checked like one.
    if (location === null || mode === "manual") return { response };

    await response.body?.cancel().catch(() => {});
    if (mode === "error") return { error: "The upstream response was a redirect.", status: 502 };
    if (followed >= MAX_REDIRECTS) return { error: "The upstream redirected too many times.", status: 502 };

    let next: string;
    try {
      next = new URL(location, url).href;
    } catch {
      return { error: "The upstream sent an invalid redirect.", status: 502 };
    }
    const target = validateProxyTarget(next, hosts);
    if ("error" in target) return { error: `The upstream redirect was refused. ${target.error}`, status: 502 };

    if (target.url.origin !== url.origin) {
      for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name);
    }
    if (
      (response.status === 303 && method !== "GET" && method !== "HEAD")
      || ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
      for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
    }
    url = target.url;
  }
}

function upstreamFailure(error: unknown): Response {
  const timedOut = error instanceof Error && error.name === "TimeoutError";
  return proxyError(timedOut ? "The upstream request timed out." : "The upstream request failed.", 504);
}

export interface HttpProxyOptions {
  /** Confirms the caller is signed in. One per isolate, so its cache is shared. */
  sessions: ProxySessionGate;
  /** Reaches the Gloomberb API for that check. */
  fetchApi: (request: Request) => Promise<Response>;
  /** Reaches the plugin's target. */
  fetchUpstream?: typeof fetch;
  hosts?: readonly string[];
}

/**
 * Note the upstream request is built only from the envelope. Forwarding the
 * incoming request's headers would hand the caller's Gloomberb session cookie
 * to a third party, which is the opposite of what this exists to do.
 */
export async function handleHttpProxy(request: Request, options: HttpProxyOptions): Promise<Response> {
  const { sessions, fetchApi, fetchUpstream = fetch, hosts = PROXY_ALLOWED_HOSTS } = options;
  if (request.method !== "POST") {
    return proxyError("Method not allowed", 405);
  }
  // Browsers send Origin on every POST, same-origin included, and the web app
  // is the only caller. A request without one did not come from the terminal.
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return proxyError("Origin not allowed", 403);
  }
  const admission = await sessions.admit(request, fetchApi);
  if (!admission.ok) {
    const headers: Record<string, string> = admission.retryAfterSeconds
      ? { "retry-after": String(admission.retryAfterSeconds) }
      : {};
    return proxyError(admission.error, admission.status, headers);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  const raw = declaredLength > MAX_REQUEST_BYTES ? null : await readTextWithin(request.body, MAX_REQUEST_BYTES);
  if (raw === null) {
    return proxyError("The plugin request is too large.", 413);
  }
  let payload: { url?: unknown; init?: unknown };
  try {
    payload = JSON.parse(raw) as { url?: unknown; init?: unknown };
  } catch {
    return proxyError("The request body is not valid JSON.", 400);
  }
  if (!payload || typeof payload !== "object") {
    return proxyError("The request body is not valid JSON.", 400);
  }

  const target = validateProxyTarget(payload.url, hosts);
  if ("error" in target) return proxyError(target.error, target.status);

  const init = readRequestInit(payload.init);
  if (!PROXY_METHODS.has(init.method)) {
    return proxyError("Method not allowed", 405);
  }

  const signal = AbortSignal.timeout(Math.min(init.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  let result: UpstreamResult;
  try {
    result = await fetchWithinAllowlist(target.url, init, fetchUpstream, hosts, signal);
  } catch (error) {
    return upstreamFailure(error);
  }
  if ("error" in result) return proxyError(result.error, result.status);
  const { response } = result;

  // Refused before reading when the upstream says up front it is too big. The
  // streamed cap below still applies, since the header can be absent or wrong.
  const tooLarge = `The upstream response is larger than ${MAX_BODY_BYTES / (1024 * 1024)} MB.`;
  if (init.method !== "HEAD" && Number(response.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {});
    return proxyError(tooLarge, 502);
  }
  let body: string | null;
  try {
    body = await readTextWithin(response.body, MAX_BODY_BYTES);
  } catch (error) {
    return upstreamFailure(error);
  }
  if (body === null) return proxyError(tooLarge, 502);

  // `set-cookie` comes back in `setCookie`, never as a header, so a third party
  // cannot set cookies on the Gloomberb origin.
  const envelope: HttpProxyResponseEnvelope = { ...toResponseHead(response), body };
  return Response.json(envelope, { headers: { "cache-control": "no-store" } });
}
