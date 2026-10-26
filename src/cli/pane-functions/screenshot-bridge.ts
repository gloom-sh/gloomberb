import { fetchTape } from "../../plugins/builtin/time-sales/client";
import {
  readRequestInit,
  toResponseEnvelope,
  type HttpProxyRequestEnvelope,
  type HttpProxyResponseEnvelope,
} from "../../utils/http-proxy-response";
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

export function createDesktopShotBridge(
  context: Pick<MarketContext, "dataProvider">,
  tapeBootstrap: typeof fetchTape = fetchTape,
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
    httpFetch: (request) => runDesktopShotHttpFetch(request),
  };
}

/**
 * Panes such as DVD fetch a third-party API directly. A browser cannot: the
 * request is cross-origin and dies in CORS, so the pane reported that the
 * ticker pays no dividend. The desktop renderer already proxies these through
 * its native half; the screenshot page gets the same treatment.
 */
async function runDesktopShotHttpFetch(
  request: HttpProxyRequestEnvelope,
): Promise<HttpProxyResponseEnvelope> {
  const target = new URL(request.url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Screenshot HTTP bridge refuses ${target.protocol} requests.`);
  }
  const { method, headers, body, redirect } = readRequestInit(request.init);
  const response = await fetch(target, {
    method,
    headers,
    body,
    redirect,
    signal: AbortSignal.timeout(SHOT_BRIDGE_HTTP_TIMEOUT_MS),
  });
  return toResponseEnvelope(response);
}
