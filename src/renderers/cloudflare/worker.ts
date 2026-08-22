interface StaticAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS: StaticAssetsBinding;
}

const SHARE_PATH = /^\/s\/[a-f0-9]{32}\/?$/;
const API_PATH = /^\/api(?:\/|$)/;
const API_ORIGIN = "https://api.gloom.sh";
const API_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
type ApiFetch = (request: Request) => Promise<Response>;

export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https://api.github.com https://api.fiscaldata.treasury.gov; form-action 'self'; upgrade-insecure-requests",
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

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withSecurityHeaders(Response.json({ error: "Method not allowed" }, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    }));
  }

  if (url.pathname === "/health") {
    return withSecurityHeaders(Response.json({ status: "ok" }));
  }
  const share = SHARE_PATH.test(url.pathname);
  if (share) {
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
