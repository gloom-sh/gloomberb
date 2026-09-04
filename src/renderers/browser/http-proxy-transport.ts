import { createProxyResponse, type HttpProxyResponseEnvelope } from "../../utils/http-proxy-response";
import type { HttpFetchTransport } from "../../utils/http-transport";
import { isProxiedHost } from "../../utils/plugin-proxy-hosts";

/**
 * Client half of the plugin HTTP transport for the hosted web app.
 *
 * A plugin calling `httpFetch` in the terminal reaches the API directly, and on
 * the desktop it goes to the Bun process. In a browser tab neither is possible:
 * most third-party APIs send no CORS headers, and headers like `Cookie` belong
 * to the browser and are dropped from anything script sets. Requests that need
 * either are posted to the worker's `/http-proxy` route instead.
 *
 * Only hosts on the shared allowlist are routed. Everything else, including
 * same-origin calls and the CORS-friendly APIs the marketplace and the data
 * sources already use, goes out as a direct fetch exactly as before. Sending
 * those through the proxy would cost a round trip, lose streaming, and be
 * refused by the worker anyway.
 */
export const HTTP_PROXY_PATH = "/http-proxy";

function needsProxy(url: string): boolean {
  try {
    const target = new URL(url, typeof location === "undefined" ? undefined : location.href);
    if (typeof location !== "undefined" && target.origin === location.origin) return false;
    return isProxiedHost(target.hostname);
  } catch {
    return false;
  }
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[key] = value;
    return record;
  }
  return { ...headers };
}

async function serializeBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  return new Response(body).text();
}

export function createBrowserHttpProxyTransport(
  send: typeof fetch = fetch,
): HttpFetchTransport {
  return async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!needsProxy(url)) return send(url, init);

    const proxied = await send(HTTP_PROXY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      signal: init?.signal ?? null,
      body: JSON.stringify({
        url,
        init: {
          method: init?.method,
          headers: headersToRecord(init?.headers),
          body: await serializeBody(init?.body),
          redirect: init?.redirect,
        },
      }),
    });

    if (!proxied.ok) {
      const detail = await proxied.text().catch(() => "");
      throw new Error(`Plugin request was refused (${proxied.status}). ${detail}`.trim());
    }
    return createProxyResponse(await proxied.json() as HttpProxyResponseEnvelope);
  };
}
