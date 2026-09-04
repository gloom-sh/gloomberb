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
import { isProxiedHost } from "../../utils/plugin-proxy-hosts";

const PROXY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const SESSION_COOKIE_NAMES = ["__Secure-gloomberb.session_token", "gloomberb.session_token"];
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
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpProxyEnvelope {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookie: string[];
  body: string;
}

/**
 * Rejects anything that is not a plain https host on the allowlist.
 *
 * IP literals are refused outright rather than range-checked: no allowlisted
 * host needs one, and it removes the entire class of "does this address point
 * somewhere internal" bugs, including the decimal and IPv6-mapped spellings
 * that defeat naive checks.
 */
export function validateProxyTarget(rawUrl: unknown): { url: URL } | { error: string; status: number } {
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
  if (!isProxiedHost(url.hostname)) {
    return { error: "The target host is not on the plugin allowlist.", status: 403 };
  }
  return { url };
}

function hasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  return SESSION_COOKIE_NAMES.some((name) => new RegExp(`(?:^|;\\s*)${name}=[^;]`).test(cookie));
}

function upstreamHeaders(raw: unknown): Headers {
  const headers = new Headers();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return headers;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
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

function clampTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function proxyError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Note the upstream request is built only from the envelope. Forwarding the
 * incoming request's headers would hand the caller's Gloomberb session cookie
 * to a third party, which is the opposite of what this exists to do.
 */
export async function handleHttpProxy(
  request: Request,
  fetchUpstream: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST") {
    return proxyError("Method not allowed", 405);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return proxyError("Origin not allowed", 403);
  }
  if (!hasSessionCookie(request)) {
    return proxyError("Sign in to use plugin requests.", 401);
  }

  let payload: { url?: unknown; init?: unknown };
  try {
    payload = await request.json() as { url?: unknown; init?: unknown };
  } catch {
    return proxyError("The request body is not valid JSON.", 400);
  }

  const target = validateProxyTarget(payload.url);
  if ("error" in target) return proxyError(target.error, target.status);

  const init = payload.init && typeof payload.init === "object" && !Array.isArray(payload.init)
    ? payload.init as Record<string, unknown>
    : {};
  const method = typeof init.method === "string" && init.method.trim()
    ? init.method.trim().toUpperCase()
    : "GET";
  if (!PROXY_METHODS.has(method)) {
    return proxyError("Method not allowed", 405);
  }
  const body = typeof init.body === "string" && method !== "GET" && method !== "HEAD"
    ? init.body
    : undefined;

  let response: Response;
  try {
    response = await fetchUpstream(target.url, {
      method,
      headers: upstreamHeaders(init.headers),
      body,
      redirect: init.redirect === "manual" || init.redirect === "error" ? init.redirect : "follow",
      signal: AbortSignal.timeout(clampTimeout(init.timeoutMs)),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return proxyError(timedOut ? "The upstream request timed out." : "The upstream request failed.", 504);
  }

  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    return proxyError("The upstream response is too large.", 502);
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    // Carried in `setCookie` instead. Emitting it here would let a third party
    // set cookies on the Gloomberb origin.
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  const setCookie = [...(response.headers.getSetCookie?.() ?? [])];
  const singleSetCookie = response.headers.get("set-cookie");
  if (setCookie.length === 0 && singleSetCookie) setCookie.push(singleSetCookie);

  const envelope: HttpProxyEnvelope = {
    status: response.status,
    statusText: response.statusText,
    headers,
    setCookie,
    body: text,
  };
  return Response.json(envelope, { headers: { "cache-control": "no-store" } });
}
