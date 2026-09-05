import { handleHttpProxy } from "./http-proxy";

interface StaticAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS: StaticAssetsBinding;
}

const SHARE_PATH = /^\/s\/[a-f0-9]{32}\/?$/;
const LAYOUT_SHARE_PATH = /^\/l\/[a-f0-9]{32}\/?$/;
const API_PATH = /^\/api(?:\/|$)/;
const HTTP_PROXY_PATH = "/http-proxy";
const APPLE_APP_SITE_ASSOCIATION_PATH = "/.well-known/apple-app-site-association";

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

export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https://api.github.com https://api.fiscaldata.treasury.gov https://plugins.gloom.sh; form-action 'self'; upgrade-insecure-requests",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function withSecurityHeaders(response: Response, options: { share?: boolean } = {}): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (options.share) headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  if ((headers.get("content-type") ?? "").includes("text/html")) {
    headers.set("cache-control", "no-store");
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
    return withSecurityHeaders(await handleHttpProxy(request));
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
  const socialShare = SHARE_PATH.test(url.pathname) || LAYOUT_SHARE_PATH.test(url.pathname);
  if (socialShare) {
    const assetUrl = new URL("/share.html", url.origin);
    const assetRequest = new Request(assetUrl, { method: request.method, headers: request.headers });
    return withSecurityHeaders(await env.ASSETS.fetch(assetRequest), { share: true });
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
