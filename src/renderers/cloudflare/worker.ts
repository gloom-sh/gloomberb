interface StaticAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS: StaticAssetsBinding;
}

const SHARE_PATH = /^\/s\/[a-f0-9]{32}\/?$/;

export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https://api.gloom.sh wss://api.gloom.sh https://api.github.com https://api.fiscaldata.treasury.gov; form-action 'self' https://api.gloom.sh; upgrade-insecure-requests",
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

export async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withSecurityHeaders(Response.json({ error: "Method not allowed" }, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    }));
  }

  const url = new URL(request.url);
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

export default { fetch: handleRequest };
