import {
  connectionHealth,
  GLOOM_CLOUD_FRED_CONNECTION_ID,
  GLOOM_CLOUD_HTTP_CONNECTION_ID,
} from "../../../../core/connection-health";
import type { DesktopBackendRequestPayload, DesktopHttpFetchResponse } from "../../shared/protocol";

function isGloomCloudUrl(url: URL): boolean {
  try {
    return url.origin === new URL(process.env.GLOOMBERB_API_URL ?? "https://api.gloom.sh").origin;
  } catch {
    return false;
  }
}

function reportCloudRequest(
  url: URL,
  method: string,
  latencyMs: number,
  success: boolean,
  error?: unknown,
): void {
  if (!isGloomCloudUrl(url)) return;
  const report = {
    operation: `${method} ${url.pathname}`,
    success,
    latencyMs,
    ...(error === undefined ? {} : { error }),
  };
  connectionHealth.reportRequest(GLOOM_CLOUD_HTTP_CONNECTION_ID, report);
  if (url.pathname.startsWith("/cloud/econ/series/")) {
    connectionHealth.reportRequest(GLOOM_CLOUD_FRED_CONNECTION_ID, report);
  }
}

function normalizeHttpFetchHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function handleHttpFetch(
  payload: DesktopBackendRequestPayload<"http.fetch">,
): Promise<DesktopHttpFetchResponse> {
  if (typeof payload.url !== "string") {
    throw new Error("http.fetch requires a URL.");
  }

  const url = new URL(payload.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported http.fetch protocol: ${url.protocol}`);
  }

  const init =
    payload.init && typeof payload.init === "object" && !Array.isArray(payload.init)
      ? payload.init as Record<string, unknown>
      : {};
  const method =
    typeof init.method === "string" && init.method.trim().length > 0
      ? init.method.trim().toUpperCase()
      : "GET";
  const redirect =
    init.redirect === "manual" || init.redirect === "error" || init.redirect === "follow"
      ? init.redirect
      : undefined;
  const body =
    typeof init.body === "string" && method !== "GET" && method !== "HEAD"
      ? init.body
      : undefined;
  const timeoutMs =
    typeof init.timeoutMs === "number"
      && Number.isFinite(init.timeoutMs)
      && init.timeoutMs > 0
      && init.timeoutMs <= 120_000
      ? init.timeoutMs
      : undefined;

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: normalizeHttpFetchHeaders(init.headers),
      body,
      redirect,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    reportCloudRequest(url, method, performance.now() - startedAt, false, error);
    throw error;
  }
  reportCloudRequest(
    url,
    method,
    performance.now() - startedAt,
    response.ok,
    response.ok ? undefined : new Error(`${response.status} ${response.statusText}`.trim()),
  );
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const setCookieHeaders = [...(response.headers.getSetCookie?.() ?? [])];
  const fallbackSetCookie = response.headers.get("set-cookie");
  if (fallbackSetCookie && setCookieHeaders.length === 0) {
    setCookieHeaders.push(fallbackSetCookie);
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    setCookie: setCookieHeaders,
    body: await response.text(),
  };
}
