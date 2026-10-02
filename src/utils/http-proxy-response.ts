/**
 * The envelope a proxied plugin request travels in.
 *
 * A renderer that cannot reach a third-party API itself (the desktop webview,
 * the hosted web app, the pane screenshot page) posts the request to a process
 * that can: the desktop's Bun backend, the web app's worker route, or the CLI
 * that serves the screenshot page. Every hop uses these shapes and helpers, so
 * the client half of each transport behaves identically.
 *
 * `set-cookie` travels beside the other headers rather than inside them,
 * because a `Headers` object built in a renderer cannot hold multiple cookies
 * and the browser strips the header anyway. Callers that read cookies, like a
 * plugin completing a login, need `get("set-cookie")` and `getSetCookie()` to
 * work, so `createProxyResponse` restores them.
 */
interface HttpProxyRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: "follow" | "error" | "manual";
  timeoutMs?: number;
}

export interface HttpProxyRequestEnvelope {
  url: string;
  init?: HttpProxyRequestInit;
}

export interface HttpProxyResponseEnvelope {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookie?: string[];
  body: string;
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

/** Client half: flattens a `fetch` call into JSON the proxy can carry. */
export async function toRequestEnvelope(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<HttpProxyRequestEnvelope> {
  return {
    url,
    init: {
      method: init?.method,
      headers: headersToRecord(init?.headers),
      body: await serializeBody(init?.body),
      redirect: init?.redirect,
      timeoutMs,
    },
  };
}

/** The request options a proxy may trust, whatever the envelope held. */
export interface ProxiedRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: "follow" | "error" | "manual";
  /** Positive and finite when present; each proxy applies its own ceiling. */
  timeoutMs?: number;
}

/** Server half: reads an envelope's `init` without trusting its shape. */
export function readRequestInit(raw: unknown): ProxiedRequestInit {
  const init = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const method = typeof init.method === "string" && init.method.trim()
    ? init.method.trim().toUpperCase()
    : "GET";
  const headers = init.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
    ? Object.fromEntries(
      Object.entries(init.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
    : {};
  return {
    method,
    headers,
    body: typeof init.body === "string" && method !== "GET" && method !== "HEAD" ? init.body : undefined,
    redirect: init.redirect === "manual" || init.redirect === "error" || init.redirect === "follow"
      ? init.redirect
      : undefined,
    timeoutMs: typeof init.timeoutMs === "number" && Number.isFinite(init.timeoutMs) && init.timeoutMs > 0
      ? init.timeoutMs
      : undefined,
  };
}

/**
 * Server half: the response head as JSON. `set-cookie` is left out of
 * `headers` and listed in `setCookie`, so a web proxy never emits a third
 * party's cookie on its own origin.
 */
export function toResponseHead(response: Response): Omit<HttpProxyResponseEnvelope, "body"> & { setCookie: string[] } {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  const setCookie = [...(response.headers.getSetCookie?.() ?? [])];
  const singleSetCookie = response.headers.get("set-cookie");
  if (setCookie.length === 0 && singleSetCookie) setCookie.push(singleSetCookie);
  return { status: response.status, statusText: response.statusText, headers, setCookie };
}

/** Server half: the whole response as JSON, body buffered. */
export async function toResponseEnvelope(response: Response): Promise<HttpProxyResponseEnvelope & { setCookie: string[] }> {
  return { ...toResponseHead(response), body: await response.text() };
}

export function createProxyResponseHeaders(
  headers: Record<string, string>,
  setCookie: string[] = [],
): Headers {
  const responseHeaders = new Headers(headers);
  if (setCookie.length === 0) return responseHeaders;

  const originalGet = responseHeaders.get.bind(responseHeaders);
  responseHeaders.get = ((name: string) => (
    name.toLowerCase() === "set-cookie" ? setCookie[0] ?? null : originalGet(name)
  )) as Headers["get"];
  (responseHeaders as Headers & { getSetCookie?: () => string[] }).getSetCookie = () => [...setCookie];
  return responseHeaders;
}

/** Client half: rebuilds a `Response` from a proxied envelope. */
export function createProxyResponse(envelope: HttpProxyResponseEnvelope): Response {
  const headers = createProxyResponseHeaders(envelope.headers, envelope.setCookie ?? []);
  const response = new Response(envelope.body, {
    status: envelope.status,
    statusText: envelope.statusText,
    headers,
  });
  // `new Response` copies the headers, which drops the accessors above.
  Object.defineProperty(response, "headers", { value: headers, configurable: true });
  return response;
}
