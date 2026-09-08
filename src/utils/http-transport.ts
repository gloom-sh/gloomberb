export type HttpFetchTransport = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpFetchTransportOptions {
  /**
   * Whether the transport resolves as soon as headers arrive and exposes a
   * live `response.body`. A transport that proxies over RPC and returns the
   * whole payload as a string must leave this false so long-lived reads such
   * as server-sent events degrade instead of hanging.
   */
  streaming?: boolean;
}

let httpFetchTransport: HttpFetchTransport | null = null;
let httpFetchStreaming = true;

export function setHttpFetchTransport(
  transport: HttpFetchTransport | null,
  options: HttpFetchTransportOptions = {},
): void {
  httpFetchTransport = transport;
  httpFetchStreaming = transport ? options.streaming ?? false : true;
}

/** False when the installed transport buffers whole responses. */
export function isHttpFetchStreaming(): boolean {
  return httpFetchStreaming;
}

export function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  return (httpFetchTransport ?? globalThis.fetch)(url, init);
}
