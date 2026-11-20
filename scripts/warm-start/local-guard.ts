import { randomBytes, timingSafeEqual } from "crypto";

/**
 * Who may reach a benchmark server on 127.0.0.1. Any program on the machine
 * and any website open in a browser can reach the port, and behind it are the
 * profile's data and fetches made from this machine (the desktop stand-in
 * answers http.fetch, notes writes and config.save). So a request must name
 * the server as `127.0.0.1:<port>` (a website that rebinds its own name to
 * this address sends its own name), and come from no other origin (a browser
 * names the page that sent it). The same rules as a pane capture's server
 * (src/cli/desktop-pane-shot.ts).
 */
export function isLocalRequest(request: Request, port: number | undefined): boolean {
  if (port === undefined) return false;
  if (request.headers.get("host") !== `127.0.0.1:${port}`) return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === `http://127.0.0.1:${port}`;
}

/** A browser always says which page opened a socket: only the server's own may. */
export function isOwnPageSocket(request: Request, port: number | undefined): boolean {
  return port !== undefined && request.headers.get("origin") === `http://127.0.0.1:${port}`;
}

/** A launch's secret folder: the page is opened under it, and nothing else is given it. */
export function newLaunchSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The path a local request asks for under the launch's secret folder
 * (`/<secret>/x` is `/x`), or null when it is not local or does not start
 * with the folder.
 */
export function secretRoute(request: Request, port: number | undefined, secret: string): string | null {
  if (!secret || !isLocalRequest(request, port)) return null;
  const { pathname } = new URL(request.url);
  const folder = `/${secret}/`;
  const given = Buffer.from(pathname.slice(0, folder.length));
  const expected = Buffer.from(folder);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return pathname.slice(folder.length - 1);
}
