/**
 * Which Gloom Cloud requests the pane screenshot page may send through its
 * local proxy, which adds the user's session (desktop-pane-shot.ts). The page
 * only draws panes, so it gets the reads panes make and nothing that acts on
 * the account: no sign-in or sign-out, billing, teams, chat, notes, sync or
 * sharing, and no write of any kind.
 */

/** The API families panes read their data from. */
const READ_FAMILIES = /^\/(?:cloud|market|news|public|research)(?:\/|$)/;
/** Auth routes inside a read family. */
const AUTH_IN_FAMILY = /^\/cloud\/auth(?:\/|$)/;
/**
 * Reads outside those families: the session and plan a pane's access gate
 * reads, the plan prices a wall shows, the service probe and the public roadmap.
 */
const READ_PATHS = new Set(["/auth/get-session", "/account/cloud", "/pricing", "/health", "/roadmap"]);
/** Reads sent as a POST because their query is a list: batches, scans and analyses. */
const READ_POSTS = new Set([
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
 * Whether the page may send `method` to the API path `path` (the part after
 * the API's base, query excluded). A path that steps up a folder or holds a
 * backslash once decoded is refused rather than trusted to reach the server
 * as the path it was checked as; an encoded slash inside a segment (a symbol
 * such as `EUR/USD`) is fine.
 */
export function isShotApiRequestAllowed(method: string, path: string): boolean {
  if (!path.startsWith("/") || path.includes("//")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Intentional ignore: a path that does not decode is refused outright, never sent on.
    return false;
  }
  if (decoded.includes("\\") || decoded.split("/").some((segment) => segment === "." || segment === "..")) return false;
  const verb = method.toUpperCase();
  if (verb === "POST") return READ_POSTS.has(path);
  if (verb !== "GET" && verb !== "HEAD") return false;
  if (READ_PATHS.has(path)) return true;
  return READ_FAMILIES.test(path) && !AUTH_IN_FAMILY.test(path);
}
