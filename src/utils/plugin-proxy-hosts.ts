/**
 * Hosts the hosted web app is allowed to reach through the worker proxy.
 *
 * Shared by both halves on purpose. The worker uses it to refuse anything else,
 * so it cannot be turned into an open proxy, and the browser uses it to decide
 * what to route: everything not listed here keeps going out as a direct fetch,
 * which is what the marketplace feed and the CORS-friendly data sources already
 * rely on. If the two lists disagreed, the client would send requests the
 * server rejects, or quietly bypass the allowlist.
 *
 * Add a host only when a plugin genuinely cannot reach it from a browser, and
 * remember that anything listed can then be reached with our IP and our
 * bandwidth.
 */
export const PROXY_ALLOWED_HOSTS = [
  // Substack sends no CORS headers at all, and its session lives in a `Cookie`
  // header that a browser will not let script set.
  "substack.com",
] as const;

/** Matches a host exactly, or as a subdomain of an allowed parent. */
export function isProxiedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PROXY_ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
