import {
  connectionHealth,
  GLOOM_CLOUD_FRED_CONNECTION_ID,
  GLOOM_CLOUD_HTTP_CONNECTION_ID,
} from "../../../../core/connection-health";
import {
  readRequestInit,
  toResponseEnvelope,
  type HttpProxyResponseEnvelope,
} from "../../../../utils/http-proxy-response";
import type { DesktopBackendRequestPayload } from "../../shared/protocol";

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
  // Crash reports, usage counts and command-search reports are background
  // traffic, kept out of the connections pane the same way the API client
  // keeps them out in-process.
  if (!isGloomCloudUrl(url) || url.pathname.startsWith("/telemetry/") || url.pathname === "/assist/searches") return;
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

export async function handleHttpFetch(
  payload: DesktopBackendRequestPayload<"http.fetch">,
): Promise<HttpProxyResponseEnvelope> {
  const url = requireProxyableUrl(payload.url, "http.fetch");
  const { method, headers, body, redirect, timeoutMs } = readRequestInit(payload.init);

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      redirect,
      signal: timeoutMs && timeoutMs <= 120_000 ? AbortSignal.timeout(timeoutMs) : undefined,
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
  return toResponseEnvelope(response);
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
