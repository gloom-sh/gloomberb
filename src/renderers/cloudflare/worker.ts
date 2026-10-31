import { handleHttpProxy } from "./http-proxy";
import { createProxySessionGate } from "./proxy-session";
import { HTTP_PROXY_PATH } from "../../utils/plugin-proxy-hosts";

interface StaticAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS: StaticAssetsBinding;
}

const SHARE_PATH = /^\/s\/[a-f0-9]{32}\/?$/;
const LAYOUT_SHARE_PATH = /^\/l\/[a-f0-9]{32}\/?$/;
const API_PATH = /^\/api(?:\/|$)/;
const APPLE_APP_SITE_ASSOCIATION_PATH = "/.well-known/apple-app-site-association";
const ROBOTS_PATH = "/robots.txt";
/**
 * Files the web build names after their contents (`main-<hash>.js`, the launch
 * frame, the bundled plugins: `withContentHash` in scripts/build-web.ts, the
 * first 16 hex digits of a SHA-256). A name never serves other bytes, so a
 * browser keeps them for a year without asking again; the bundle audit checks
 * each such name against its file. Lazy chunks keep plain names and are
 * revalidated as before.
 */
export const IMMUTABLE_ASSET_PATH = /^\/assets\/.+-[a-f0-9]{16}\.(?:js|css)$/;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
/**
 * The icons and the install manifest keep their names from build to build.
 * The browser asked whether each had changed before the first paint of every
 * open; a copy up to a day old does no harm.
 */
const DAILY_ASSET_PATH = /^\/(?:favicon\.(?:ico|svg)|manifest\.webmanifest|app-icon-\d+\.png)$/;
const DAILY_CACHE_CONTROL = "public, max-age=86400";

/**
 * Crawling stays allowed on purpose. Deep links are kept out of the index by
 * the `x-robots-tag` header on their HTML, which a crawler only sees if it may
 * fetch the page. A `Disallow` would leave already indexed URLs stuck as
 * "Indexed, though blocked by robots.txt".
 */
const ROBOTS_TXT = "User-agent: *\nAllow: /\n";

/**
 * Lets the iOS app claim `https://term.gloom.sh/s/...` share links.
 *
 * Apple fetches this over HTTPS with its own client, so it has to be a direct
 * 200 with JSON content type: a redirect, an HTML error page, or a 404 all
 * silently disable universal links with no visible failure on device.
 *
 * The path list mirrors `SHARE_PATH` above. Only pane/content shares are
 * claimed. Layout permalinks stay in the browser so their page can preview the
 * workspace and hand it to the hosted terminal as an editable copy.
 *
 * `3XQML3UV65` is the Apple team id that prefixes the app id.
 */
const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    details: [
      {
        appIDs: ["3XQML3UV65.sh.gloom.companion"],
        components: [{ "/": "/s/*", comment: "Public portfolio shares" }],
      },
    ],
  },
} as const;
const API_ORIGIN = "https://api.gloom.sh";
const API_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
type ApiFetch = (request: Request) => Promise<Response>;
/** Module scope, so every request this isolate serves shares one session cache. */
const proxySessions = createProxySessionGate({ sessionUrl: `${API_ORIGIN}/auth/get-session` });

export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https://api.github.com https://api.fiscaldata.treasury.gov https://plugins.gloom.sh https://gloom.sh; form-action 'self'; upgrade-insecure-requests",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function withSecurityHeaders(response: Response, options: { share?: boolean; noindex?: boolean; keep?: "immutable" | "daily" } = {}): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  const html = (headers.get("content-type") ?? "").includes("text/html");
  if (options.share) headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  else if (options.noindex && html) headers.set("x-robots-tag", "noindex");
  if (html) headers.set("cache-control", "no-store");
  // Only the file itself: a name the build no longer has falls back to the app's HTML, which stays no-store.
  else if (options.keep && (response.ok || response.status === 304)) {
    headers.set("cache-control", options.keep === "immutable" ? IMMUTABLE_CACHE_CONTROL : DAILY_CACHE_CONTROL);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function proxyApi(request: Request, fetchApi: ApiFetch): Promise<Response> {
  const url = new URL(request.url);
  if (!API_METHODS.has(request.method)) {
    return Response.json({ error: "Method not allowed" }, {
      status: 405,
      headers: { Allow: [...API_METHODS].join(", ") },
    });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return Response.json({ error: "Origin not allowed" }, { status: 403 });
  }
  const upstreamUrl = new URL(`${url.pathname.slice(4) || "/"}${url.search}`, API_ORIGIN);
  return fetchApi(new Request(upstreamUrl, request));
}

export async function handleRequest(request: Request, env: WorkerEnv, fetchApi: ApiFetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (API_PATH.test(url.pathname)) return proxyApi(request, fetchApi);
  // Before the GET/HEAD gate below, since plugin requests arrive as POST.
  if (url.pathname === HTTP_PROXY_PATH) {
    return withSecurityHeaders(await handleHttpProxy(request, { sessions: proxySessions, fetchApi }));
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withSecurityHeaders(Response.json({ error: "Method not allowed" }, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    }));
  }

  if (url.pathname === "/health") {
    return withSecurityHeaders(Response.json({ status: "ok" }));
  }

  // Served before the asset handler so it cannot be shadowed by a static file
  // or the SPA fallback, either of which would hand Apple HTML and quietly
  // break universal links.
  if (url.pathname === APPLE_APP_SITE_ASSOCIATION_PATH) {
    return withSecurityHeaders(
      Response.json(APPLE_APP_SITE_ASSOCIATION, {
        headers: { "cache-control": "public, max-age=3600" },
      }),
    );
  }
  // Without this the SPA fallback answers with the app's HTML.
  if (url.pathname === ROBOTS_PATH) {
    return withSecurityHeaders(new Response(ROBOTS_TXT, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
    }));
  }
  const socialShare = SHARE_PATH.test(url.pathname) || LAYOUT_SHARE_PATH.test(url.pathname);
  if (socialShare) {
    const assetUrl = new URL("/share.html", url.origin);
    const assetRequest = new Request(assetUrl, { method: request.method, headers: request.headers });
    return withSecurityHeaders(await env.ASSETS.fetch(assetRequest), { share: true });
  }
  // Every path and query gets the same "Gloomberb" shell, so deep links such as
  // `/?ticker=GPC&tab=executives` would be indexed as thin duplicates. Only the
  // bare root stays indexable.
  const deepLink = url.pathname !== "/" || url.search !== "";
  const keep = IMMUTABLE_ASSET_PATH.test(url.pathname) ? "immutable" : DAILY_ASSET_PATH.test(url.pathname) ? "daily" : undefined;
  return withSecurityHeaders(await env.ASSETS.fetch(request), { noindex: deepLink, keep });
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
