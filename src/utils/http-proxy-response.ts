/**
 * Rebuilds a `Response` from a proxied envelope.
 *
 * Both proxying transports (desktop's Bun backend, the web app's worker route)
 * return `set-cookie` alongside the other headers rather than inside them,
 * because a `Headers` object built in a renderer cannot hold multiple cookies
 * and the browser strips the header anyway. Callers that read cookies, like a
 * plugin completing a login, need `get("set-cookie")` and `getSetCookie()` to
 * work, so those are restored here.
 */
export interface HttpProxyResponseEnvelope {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookie?: string[];
  body: string;
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
