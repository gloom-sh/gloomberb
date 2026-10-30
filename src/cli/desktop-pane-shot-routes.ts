/**
 * Routes the pane screenshot page (cli-pane-shot-entry.tsx) calls on the Bun
 * server that serves it (desktop-pane-shot.ts).
 */
export const SHOT_API_PROXY_PREFIX = "/__gloom_cli_api__";
export const SHOT_MARKET_BRIDGE_PATH = "/__gloom_cli_market__";
export const SHOT_HTTP_BRIDGE_PATH = "/__gloom_cli_http__";
/**
 * The page's Cloud API reads, over one socket: a page's fetches share six
 * connections to its origin, so a board's seventy contract histories and terms
 * queued behind each other for seconds.
 */
export const SHOT_API_SOCKET_PATH = "/__gloom_cli_api_socket__";

/** A read the page sends over the socket: an API path with its query, and the request's headers. */
export interface ShotApiSocketCall {
  id: number;
  path: string;
  headers: Array<[string, string]>;
}

/** The server's answer to a call: the response with its body in base64, or why it could not be made. */
export type ShotApiSocketReply =
  | { id: number; status: number; statusText: string; headers: Array<[string, string]>; body: string }
  | { id: number; error: string };
