import {
  createProxyResponse,
  toRequestEnvelope,
  type HttpProxyResponseEnvelope,
} from "../../utils/http-proxy-response";
import type { HttpFetchTransport } from "../../utils/http-transport";
import { HTTP_PROXY_PATH, isProxiedHost, PROXY_ALLOWED_HOSTS } from "../../utils/plugin-proxy-hosts";

function needsProxy(url: string, hosts: readonly string[]): boolean {
  try {
    const target = new URL(url, typeof location === "undefined" ? undefined : location.href);
    if (typeof location !== "undefined" && target.origin === location.origin) return false;
    return isProxiedHost(target.hostname, hosts);
  } catch {
    return false;
  }
}

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
export function createBrowserHttpProxyTransport(
  send: typeof fetch = fetch,
  hosts: readonly string[] = PROXY_ALLOWED_HOSTS,
): HttpFetchTransport {
  return async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!needsProxy(url, hosts)) return send(url, init);

    const proxied = await send(HTTP_PROXY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      signal: init?.signal ?? null,
      body: JSON.stringify(await toRequestEnvelope(url, init)),
    });

    if (!proxied.ok) {
      const detail = await proxied.text().catch(() => "");
      throw new Error(`Plugin request was refused (${proxied.status}). ${detail}`.trim());
    }
    return createProxyResponse(await proxied.json() as HttpProxyResponseEnvelope);
  };
}
