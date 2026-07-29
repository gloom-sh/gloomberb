import type { DesktopBackendRequestPayload, DesktopHttpFetchResponse } from "../../shared/protocol";

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

  const response = await fetch(url, {
    method,
    headers: normalizeHttpFetchHeaders(init.headers),
    body,
    redirect,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
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
