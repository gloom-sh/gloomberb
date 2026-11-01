/**
 * Which Gloom Cloud requests the pane screenshot page may send through its
 * local proxy, which adds the user's session (desktop-pane-shot.ts). The page
 * only draws panes, so it gets the reads panes make and nothing that acts on
 * the account: no sign-in or sign-out, billing, keys, chat, sync or sharing,
 * and no write of any kind.
 */

/** The API families panes read their data from. */
const READ_FAMILIES = /^\/(?:cloud|market|news|public|research)(?:\/|$)/;
/** Auth routes inside a read family. */
const AUTH_IN_FAMILY = /^\/cloud\/auth(?:\/|$)/;
/**
 * Reads outside those families that panes make, none of whose answers holds a
 * credential, token or key: the session and plan an access gate reads (the
 * session cut to its user, see `isShotSessionPath`), plan prices, the service
 * probe, the roadmap, the layout gallery (marketplace and team layouts),
 * theses, and a signed-in broker's catalog, connection status, holdings,
 * orders and fills. The Buildout plan is one: its answer is the plan and its
 * prices, never the token `POST /account/buildout/token` mints, which stays
 * refused, so the Buildout panes cannot be drawn with a plan's data.
 */
const READ_PATHS = [
  /^\/auth\/get-session$/,
  /^\/account\/cloud$/,
  /^\/account\/buildout$/,
  /^\/pricing$/,
  /^\/health$/,
  /^\/roadmap$/,
  /^\/layouts(?:\/[^/]+)?$/,
  /^\/teams\/[^/]+\/layouts$/,
  /^\/theses(?:\/[^/]+)?$/,
  /^\/brokers\/connectors$/,
  /^\/brokers\/[a-z][a-z0-9-]{0,31}(?:\/(?:snapshot|orders|executions))?$/,
];
/**
 * Reads sent as a POST because their query is a list or a definition: batches,
 * scans, analyses and the equity screen's query. Its saved-screen writes,
 * ticker check and export are not here.
 */
const READ_POSTS = new Set([
  "/cloud/equity-screener/query",
  "/cloud/exposure/analyze",
  "/cloud/perps/equities",
  "/market/financials/batch",
  "/market/history/batch",
  "/market/organization-tickers",
  "/market/quotes/batch",
  "/market/scanner/live",
  "/market/search/batch",
  "/market/ticker-changes/batch",
  "/research/equity-diagnostic",
]);

/**
 * The path as a server could read it: decoded and lower-cased, so an escaped
 * letter or another case cannot step past a check. Null for one that steps up
 * a folder or holds a backslash once decoded, which is refused rather than
 * trusted to reach the server as the path it was checked as. An encoded slash
 * inside a segment (a symbol such as `EUR/USD`) is fine.
 */
function readablePath(path: string): string | null {
  if (!path.startsWith("/") || path.includes("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Intentional ignore: a path that does not decode is refused outright, never sent on.
    return null;
  }
  if (decoded.includes("\\") || decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return decoded.toLowerCase();
}

/**
 * Whether the page may send `method` to the API path `path` (the part after
 * the API's base, query excluded). A batch read sent as POST must be named
 * exactly, with nothing escaped.
 */
export function isShotApiRequestAllowed(method: string, path: string): boolean {
  const readable = readablePath(path);
  if (readable === null) return false;
  const verb = method.toUpperCase();
  if (verb === "POST") return READ_POSTS.has(path);
  if (verb !== "GET" && verb !== "HEAD") return false;
  if (READ_PATHS.some((pattern) => pattern.test(readable))) return true;
  return READ_FAMILIES.test(readable) && !AUTH_IN_FAMILY.test(readable);
}

/** The session read, whose answer also carries the session's token: the proxy hands the page its user alone. */
export function isShotSessionPath(path: string): boolean {
  return readablePath(path) === "/auth/get-session";
}
