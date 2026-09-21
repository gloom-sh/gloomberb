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

export function reportCloudRequest(
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

export function normalizeHttpFetchHeaders(headers: unknown): Record<string, string> {
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
  const url = requireProxyableUrl(payload.url, "http.fetch");

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
  const { headers, setCookie } = collectResponseHeaders(response);

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    setCookie,
    body: await response.text(),
  };
}

/** Plain header map plus the `Set-Cookie` list the view replays itself. */
export function collectResponseHeaders(response: Response): {
  headers: Record<string, string>;
  setCookie: string[];
} {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const setCookie = [...(response.headers.getSetCookie?.() ?? [])];
  const fallback = response.headers.get("set-cookie");
  if (fallback && setCookie.length === 0) setCookie.push(fallback);
  return { headers, setCookie };
}

/** Rejects anything the desktop must not proxy on the app's behalf. */
export function requireProxyableUrl(rawUrl: unknown, method: string): URL {
  if (typeof rawUrl !== "string") {
    throw new Error(`${method} requires a URL.`);
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported ${method} protocol: ${url.protocol}`);
  }
  return url;
}
