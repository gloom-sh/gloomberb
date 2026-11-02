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

/**
 * Declared hosts the browser calls directly instead of through the proxy,
 * because they answer the terminal's origin with CORS headers and need no
 * header a browser cannot set. The worker lists them in `connect-src`, and
 * the generator leaves them off the proxy list, so a request to one never
 * costs a worker round trip or a slot in anyone's rate limit.
 *
 * Add a host here only after checking that it sends
 * `access-control-allow-origin` for https://term.gloom.sh, preflight
 * included when the plugin sends `Authorization`.
 */
export const WEB_DIRECT_HOSTS: readonly string[] = ["api.fiscaldata.treasury.gov", "api.thebuildout.ai"];

/** The worker route the browser posts proxied requests to. */
export const HTTP_PROXY_PATH = "/http-proxy";

/** Matches a host exactly, or as a subdomain of an allowed parent. */
export function isProxiedHost(hostname: string, hosts: readonly string[] = PROXY_ALLOWED_HOSTS): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
