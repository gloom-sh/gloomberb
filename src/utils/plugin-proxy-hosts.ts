import allowed from "./plugin-proxy-hosts.json";

/**
 * Hosts the hosted web app is allowed to reach through the worker proxy.
 *
 * The list is not written by hand. It is generated from the `hosts` every
 * plugin in the browser catalog declares (`scripts/generate-web-proxy-hosts.ts`,
 * checked in CI), so a plugin bundled into the web app gets its hosts proxied
 * by declaring them and nothing else does. Anything listed can be reached with
 * our IP and our bandwidth, which is why the worker refuses everything else
 * and why the list is exactly what shipped plugins need.
 *
 * Shared by both halves on purpose. The worker uses it to refuse, and the
 * browser uses it to decide what to route: everything not listed keeps going
 * out as a direct fetch, which is what the marketplace feed and the
 * CORS-friendly data sources already rely on. If the two disagreed, the client
 * would send requests the server rejects, or quietly bypass the allowlist.
 */
export const PROXY_ALLOWED_HOSTS: readonly string[] = allowed.hosts;

/** Matches a host exactly, or as a subdomain of an allowed parent. */
export function isProxiedHost(hostname: string, hosts: readonly string[] = PROXY_ALLOWED_HOSTS): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
