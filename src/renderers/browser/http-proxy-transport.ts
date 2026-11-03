import {
  createProxyResponse,
  toRequestEnvelope,
  type HttpProxyResponseEnvelope,
} from "../../utils/http-proxy-response";
import type { HttpFetchTransport } from "../../utils/http-transport";
import { HTTP_PROXY_PATH, isProxiedHost, PROXY_ALLOWED_HOSTS } from "../../utils/plugin-proxy-hosts";

/** Thrown when the worker refuses or cannot complete a proxied request. */
class ProxyRefusedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProxyRefusedError";
  }
}

const UNREACHABLE = "The data source could not be reached. Check your connection and try again.";
const UNREADABLE = "The data source's answer could not be read. Try again shortly.";
/** Longer than any sentence the worker writes; anything past it is not one of them. */
const MAX_REFUSAL_LENGTH = 160;

/**
 * The sentence a pane shows for a refusal. The worker answers with
 * `{ error }` in plain words; anything else (an edge error page, a body cut
 * short, a message that is not one short line) gets a sentence for its
 * status, never the raw body.
 */
async function refusalMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const error = typeof body?.error === "string" ? body.error.trim() : "";
  if (error && error.length <= MAX_REFUSAL_LENGTH && !/[{}<>\n]/.test(error)) return error;
  if (response.status === 429) return "Too many requests right now. Try again in a minute.";
  if (response.status >= 500) return "The data source could not be reached. Try again shortly.";
  return "This request could not be completed.";
}

function isEnvelope(value: unknown): value is HttpProxyResponseEnvelope {
  if (!value || typeof value !== "object") return false;
  const { status, headers, body } = value as Partial<HttpProxyResponseEnvelope>;
  return typeof status === "number" && !!headers && typeof headers === "object" && typeof body === "string";
}

/**
 * A request that never got an answer fails with the browser's own words
 * ("Failed to fetch", "Load failed"), which a pane would print as they are.
 * It becomes a sentence instead, keeping the original as `cause` for code
 * that classifies network failures. A caller's abort or timeout stays as it
 * was, since callers check for those by name.
 */
async function answered(request: () => Promise<Response>, signal: AbortSignal | null | undefined): Promise<Response> {
  try {
    return await request();
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (signal?.aborted || name === "AbortError" || name === "TimeoutError") throw error;
    throw new Error(UNREACHABLE, { cause: error });
  }
}

/**
 * A browser owns `User-Agent`. Chrome drops one set by script, but Firefox
 * sends it, which turns a simple cross-origin GET into a preflight that some
 * of the hosts called directly do not allow. Every browser leaves it out.
 */
function withoutUserAgent(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) return init;
  headers.delete("user-agent");
  return { ...init, headers };
}

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
    if (!needsProxy(url, hosts)) return answered(() => send(url, withoutUserAgent(init)), init?.signal);

    const envelope = await toRequestEnvelope(url, init);
    const proxied = await answered(() => send(HTTP_PROXY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      signal: init?.signal ?? null,
      body: JSON.stringify(envelope),
    }), init?.signal);

    if (!proxied.ok) throw new ProxyRefusedError(await refusalMessage(proxied), proxied.status);
    // A 200 that is not an envelope (an HTML page from a route that is not
    // the worker's) would otherwise surface as a JSON SyntaxError quoting it.
    const answer = await proxied.json().catch(() => null);
    if (!isEnvelope(answer)) throw new ProxyRefusedError(UNREADABLE, proxied.status);
    try {
      return createProxyResponse(answer);
    } catch {
      throw new ProxyRefusedError(UNREADABLE, proxied.status);
    }
  };
}
