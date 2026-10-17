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
 *
 * JSON only holds text, so a body that is not UTF-8 (a zip archive, an image,
 * a CSV in another charset) travels as base64 in `bodyBase64`. Decoding those
 * bytes as text would replace every invalid sequence and leave the plugin a
 * corrupt file.
 */
interface HttpProxyRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** A binary body, such as an image upload, which `body` would mangle as text. */
  bodyBase64?: string;
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
  /** The body when it is UTF-8 text; empty when `bodyBase64` carries it. */
  body: string;
  /** Any other body, byte for byte. */
  bodyBase64?: string;
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

/** A multiple of 3, so every slice encodes without padding and the parts join into one string. */
const BASE64_CHUNK_BYTES = 3 * 0x2000;

/**
 * The native codec where the runtime has one, over ten times faster on a 20 MB
 * archive. Older webviews still need the fallback.
 */
export function encodeBase64(bytes: Uint8Array, native = typeof bytes.toBase64 === "function"): string {
  if (native) return bytes.toBase64();
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))));
  }
  return parts.join("");
}

/** Undefined when `value` is not base64. */
export function decodeBase64(
  value: string,
  native = typeof Uint8Array.fromBase64 === "function",
): Uint8Array<ArrayBuffer> | undefined {
  try {
    if (native) return Uint8Array.fromBase64(value);
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    // Intentional ignore: Invalid base64 is represented by undefined for the envelope validator.
    return undefined;
  }
}

function isBinaryBody(body: BodyInit): boolean {
  return (typeof Blob !== "undefined" && body instanceof Blob)
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body);
}

async function serializeBody(body: BodyInit | null | undefined): Promise<Pick<HttpProxyRequestInit, "body" | "bodyBase64">> {
  if (body == null) return {};
  if (typeof body === "string") return { body };
  if (isBinaryBody(body)) {
    return { bodyBase64: encodeBase64(new Uint8Array(await new Response(body).arrayBuffer())) };
  }
  return { body: await new Response(body).text() };
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
      ...await serializeBody(init?.body),
      redirect: init?.redirect,
      timeoutMs,
    },
  };
}

/** The request options a proxy may trust, whatever the envelope held. */
export interface ProxiedRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
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
  const acceptsBody = method !== "GET" && method !== "HEAD";
  return {
    method,
    headers,
    body: !acceptsBody
      ? undefined
      : typeof init.body === "string"
        ? init.body
        : typeof init.bodyBase64 === "string" ? decodeBase64(init.bodyBase64) : undefined,
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
export function toResponseHead(response: Response): Omit<HttpProxyResponseEnvelope, "body" | "bodyBase64"> & { setCookie: string[] } {
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

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Server half: a buffered body as envelope fields. UTF-8 text stays in `body`,
 * so text responses read exactly as before; anything else goes as base64.
 */
export function encodeResponseBody(bytes: Uint8Array): Pick<HttpProxyResponseEnvelope, "body" | "bodyBase64"> {
  // Decoding drops a leading byte-order mark, so a body that starts with one
  // would lose those three bytes if it went as text.
  const hasByteOrderMark = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (!hasByteOrderMark) {
    try {
      return { body: STRICT_UTF8.decode(bytes) };
    } catch {
      // Intentional ignore: Non-UTF-8 bodies are encoded as base64 below.
    }
  }
  return { body: "", bodyBase64: encodeBase64(bytes) };
}

/** Server half: the whole response as JSON, body buffered. */
export async function toResponseEnvelope(response: Response): Promise<HttpProxyResponseEnvelope & { setCookie: string[] }> {
  return { ...toResponseHead(response), ...encodeResponseBody(new Uint8Array(await response.arrayBuffer())) };
}

/** Client half: the body as `Response` reads it. A corrupt one throws rather than reading as empty. */
function readEnvelopeBody(envelope: HttpProxyResponseEnvelope): string | Uint8Array<ArrayBuffer> {
  if (typeof envelope.bodyBase64 !== "string") return envelope.body;
  const bytes = decodeBase64(envelope.bodyBase64);
  if (!bytes) throw new Error("The proxied response body is not valid base64.");
  return bytes;
}

/** Client half: the body as text, the way `Response.text()` would read it. */
export function readProxyResponseText(envelope: HttpProxyResponseEnvelope): string {
  const body = readEnvelopeBody(envelope);
  return typeof body === "string" ? body : new TextDecoder().decode(body);
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

/** Statuses a browser refuses to construct with any body, even an empty one. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Client half: rebuilds a `Response` from a proxied envelope. */
export function createProxyResponse(envelope: HttpProxyResponseEnvelope): Response {
  const headers = createProxyResponseHeaders(envelope.headers, envelope.setCookie ?? []);
  const body = NULL_BODY_STATUSES.has(envelope.status) ? null : readEnvelopeBody(envelope);
  const response = new Response(body, {
    status: envelope.status,
    statusText: envelope.statusText,
    headers,
  });
  // `new Response` copies the headers, which drops the accessors above.
  Object.defineProperty(response, "headers", { value: headers, configurable: true });
  return response;
}
