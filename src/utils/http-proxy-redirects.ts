import type { ProxiedRequestInit } from "./http-proxy-response";

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

/** Whether a proxy may reach a URL: the URL to fetch, or why not and the status to answer with. */
export type ProxyTargetCheck = (url: string) => ProxyTargetVerdict | Promise<ProxyTargetVerdict>;
type ProxyTargetVerdict = { url: URL } | { error: string; status: number };

export type ProxyUpstreamResult = { response: Response } | { error: string; status: number };

function upstreamHeaders(raw: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    try {
      headers.set(name, value);
    } catch {
      // Intentional ignore: a header name the runtime refuses is dropped, as a browser drops an unsettable header.
    }
  }
  return headers;
}

/**
 * Fetches a proxied plugin request, following redirects one hop at a time
 * instead of letting `fetch` do it, so every `Location` passes the same
 * `check` as the first URL. A host that redirects elsewhere (an open
 * redirect, a moved API) would otherwise carry the request anywhere.
 *
 * Method and header handling mirror the Fetch spec: 303, and 301/302 after a
 * POST, become a bodiless GET; credentials the plugin set are dropped when the
 * redirect leaves the origin they were meant for.
 */
export async function fetchCheckingRedirects(
  first: URL,
  init: ProxiedRequestInit,
  options: { fetch: typeof fetch; check: ProxyTargetCheck; signal: AbortSignal },
): Promise<ProxyUpstreamResult> {
  const headers = upstreamHeaders(init.headers);
  const mode = init.redirect ?? "follow";
  let url = first;
  let method = init.method;
  let body = init.body;

  for (let followed = 0; ; followed += 1) {
    const response = await options.fetch(url, { method, headers, body, redirect: "manual", signal: options.signal });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    // "manual" hands the redirect back to the plugin. If it follows it, that
    // comes back through here as a new request and is checked like one.
    if (location === null || mode === "manual") return { response };

    await response.body?.cancel().catch(() => { /* Intentional ignore: the redirect's own body is never read, only dropped. */ });
    if (mode === "error") return { error: "The upstream response was a redirect.", status: 502 };
    if (followed >= MAX_REDIRECTS) return { error: "The upstream redirected too many times.", status: 502 };

    let next: string;
    try {
      next = new URL(location, url).href;
    } catch {
      // Intentional ignore: a Location that does not parse is reported as an invalid redirect, never followed.
      return { error: "The upstream sent an invalid redirect.", status: 502 };
    }
    const target = await options.check(next);
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
