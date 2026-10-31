import { lookup } from "dns/promises";
import { isIP } from "net";
import { fetchTape } from "../../plugins/builtin/time-sales/client";
import {
  encodeResponseBody,
  readRequestInit,
  toResponseHead,
  type HttpProxyRequestEnvelope,
  type HttpProxyResponseEnvelope,
} from "../../utils/http-proxy-response";
import { fetchCheckingRedirects, readBytesWithin } from "../../utils/http-proxy-upstream";
import { isPublicAddress } from "../../utils/public-address";
import type { DesktopPaneShotApiProxy, DesktopPaneShotBridge } from "../desktop-pane-shot";
import type { MarketContext } from "../types";
import { resolvePersistedCloudSessionToken } from "./cloud-session";
import { getCloudApiBaseUrl } from "../../api-client/request";

const CREDENTIAL_FIELD_NAMES = new Set([
  "accesstoken",
  "accessurl",
  "apikey",
  "apisecret",
  "authorization",
  "cookie",
  "credentials",
  "oauth",
  "passphrase",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "token",
]);

/**
 * The proxy receives the desktop session out of band. Keeping this separate
 * from DesktopPaneShotPayload prevents the token from entering the page,
 * semantic evidence, or JSON CLI output.
 */
function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return CREDENTIAL_FIELD_NAMES.has(normalized)
    || normalized.endsWith("password")
    || normalized.endsWith("passphrase")
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("credential")
    || normalized.endsWith("cookie")
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesskey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("authorization")
    || normalized.endsWith("accessurl");
}

/** Removes credential-shaped object fields before data enters the page or JSON output. */
export function stripDesktopShotCredentials<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripDesktopShotCredentials(entry)) as T;
  }
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialField(key)) continue;
    clean[key] = stripDesktopShotCredentials(entry);
  }
  return clean as T;
}

export function resolveDesktopShotApiProxy(
  context: Pick<MarketContext, "persistence">,
): DesktopPaneShotApiProxy {
  return {
    baseUrl: getCloudApiBaseUrl(),
    sessionToken: resolvePersistedCloudSessionToken(context),
  };
}

/**
 * Data the page may request while it renders. The cloud API is only one of the
 * router's sources, so calling it directly from the page dropped whatever
 * another provider contributes: analyst rating price targets came back empty
 * and corporate actions vanished whenever the cloud leg failed. Quotes are
 * here for board panes that list symbols the payload was never built for.
 * These run on the Bun side through the same router `gloom fn` uses.
 */
const SHOT_BRIDGE_MARKET_OPERATIONS = new Set([
  "getAnalystResearch",
  "getCorporateActions",
  "getEarningsCalendar",
  "getHolders",
  "getOptionsChain",
  "getCloudTape",
  "getPriceHistory",
  "getPriceHistoryForResolution",
  "getQuote",
  "getQuoteMetadata",
  "getQuotesBatch",
  "getSecFilingContent",
  "getSecFilingDocuments",
  "getSecFilings",
]);

const SHOT_BRIDGE_HTTP_TIMEOUT_MS = 20_000;
/** Feeds and API answers are far smaller; the answer goes to the page whole, as JSON. */
const SHOT_BRIDGE_HTTP_MAX_BYTES = 25 * 1024 * 1024;
/** What panes send through `httpFetch` while they draw: reads, and the POST a few APIs take a query as. */
const SHOT_BRIDGE_HTTP_METHODS = new Set(["GET", "HEAD", "POST"]);

/** The addresses a host name resolves to. */
type ResolveHost = (hostname: string) => Promise<string[]>;

const resolveHost: ResolveHost = async (hostname) => (
  await lookup(hostname, { all: true, verbatim: true })
).map((entry) => entry.address);

interface ShotHttpOptions {
  resolveHost?: ResolveHost;
  fetch?: typeof fetch;
}

export function createDesktopShotBridge(
  context: Pick<MarketContext, "dataProvider">,
  tapeBootstrap: typeof fetchTape = fetchTape,
  httpOptions: ShotHttpOptions = {},
): DesktopPaneShotBridge {
  return {
    async marketData(operation, args) {
      if (!SHOT_BRIDGE_MARKET_OPERATIONS.has(operation)) {
        throw new Error(`Screenshot market bridge does not serve "${operation}".`);
      }
      if (operation === "getCloudTape") {
        const [symbol, exchange] = args;
        if (typeof symbol !== "string" || typeof exchange !== "string") throw new Error("Tape screenshots require a symbol and listing exchange.");
        return tapeBootstrap(symbol, exchange);
      }
      const provider = context.dataProvider as unknown as Record<string, unknown>;
      const handler = provider[operation];
      if (typeof handler !== "function") {
        throw new Error(`No provider available for ${operation}.`);
      }
      return await (handler as (...values: unknown[]) => Promise<unknown>).apply(
        context.dataProvider,
        args,
      );
    },
    httpFetch: (request) => runDesktopShotHttpFetch(request, httpOptions),
  };
}

/**
 * Whether the page may reach `raw`: http or https on a host whose every
 * address is on the public internet. Panes read public APIs and news feeds;
 * nothing they draw lives on this machine or its network, and a URL that
 * names one (or a host that resolves to one) is refused.
 *
 * The fetch looks the name up again, so a name whose answer changes between
 * the two lookups is not caught here. Pinning the fetch to the checked
 * address needs a Host header and a TLS server name on an IP URL, and Bun's
 * fetch does not verify or pool such connections predictably enough to rely on.
 */
async function checkShotHttpTarget(
  raw: string,
  resolve: ResolveHost,
): Promise<{ url: URL } | { error: string; status: number }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Intentional ignore: a URL that does not parse is answered as an invalid target, never fetched.
    return { error: "The target URL is not valid.", status: 400 };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `Screenshot HTTP bridge refuses ${url.protocol} requests.`, status: 400 };
  }
  if (url.username || url.password) return { error: "Credentials in the URL are not allowed.", status: 400 };
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const refused = { error: `Screenshot HTTP bridge refuses ${url.hostname}: it is not on the public internet.`, status: 403 };
  if (host === "localhost" || host.endsWith(".localhost")) return refused;
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return { error: `Could not resolve ${url.hostname}.`, status: 502 };
  }
  if (addresses.length === 0) return { error: `Could not resolve ${url.hostname}.`, status: 502 };
  return addresses.every(isPublicAddress) ? { url } : refused;
}

/**
 * Panes such as DVD fetch a third-party API directly. A browser cannot: the
 * request is cross-origin and dies in CORS, so the pane reported that the
 * ticker pays no dividend. The desktop renderer already proxies these through
 * its native half; the screenshot page gets the same treatment, limited to
 * public hosts, each redirect checked like the first URL.
 */
async function runDesktopShotHttpFetch(
  request: HttpProxyRequestEnvelope,
  options: ShotHttpOptions,
): Promise<HttpProxyResponseEnvelope> {
  const resolve = options.resolveHost ?? resolveHost;
  const target = await checkShotHttpTarget(typeof request?.url === "string" ? request.url : "", resolve);
  if ("error" in target) throw new Error(target.error);
  const init = readRequestInit(request.init);
  if (!SHOT_BRIDGE_HTTP_METHODS.has(init.method)) {
    throw new Error(`Screenshot HTTP bridge refuses ${init.method} requests.`);
  }
  const result = await fetchCheckingRedirects(target.url, init, {
    fetch: options.fetch ?? fetch,
    check: (url) => checkShotHttpTarget(url, resolve),
    signal: AbortSignal.timeout(SHOT_BRIDGE_HTTP_TIMEOUT_MS),
  });
  if ("error" in result) throw new Error(result.error);
  const { response } = result;
  const tooLarge = `The response from ${target.url.hostname} is larger than ${SHOT_BRIDGE_HTTP_MAX_BYTES / (1024 * 1024)} MB.`;
  if (init.method !== "HEAD" && Number(response.headers.get("content-length") ?? 0) > SHOT_BRIDGE_HTTP_MAX_BYTES) {
    await response.body?.cancel().catch(() => { /* Intentional ignore: an answer over the cap is dropped unread. */ });
    throw new Error(tooLarge);
  }
  const body = await readBytesWithin(response.body, SHOT_BRIDGE_HTTP_MAX_BYTES);
  if (body === null) throw new Error(tooLarge);
  return { ...toResponseHead(response), ...encodeResponseBody(body) };
}
