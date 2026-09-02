import type { InstalledPlugin } from "./model";

/**
 * The marketplace pane needs two things no other pane does: the full plugin
 * catalog including entries that failed to load, and the ability to enable and
 * disable them. Neither is on the render-time plugin runtime, and widening the
 * public plugin API for a single built-in consumer would be the wrong trade.
 *
 * So the app binds a host here at startup, the same way the layout manager
 * receives its dispatch from `bindAppPanePluginRegistry`.
 */

export interface MarketplaceHost {
  listInstalled(): InstalledPlugin[];
  setPluginEnabled(pluginId: string, enabled: boolean): void;
}

let host: MarketplaceHost | null = null;

export function setMarketplaceHost(next: MarketplaceHost | null): void {
  host = next;
}

export function getMarketplaceHost(): MarketplaceHost | null {
  return host;
}

/**
 * Installing a plugin means running git and bun, which only the Bun-hosted
 * renderers can do — and the desktop view has to ask its Bun process over RPC.
 * Rather than let this pane reach for a renderer API and break the
 * renderer-neutrality rule, each renderer installs its own implementation at
 * startup. A renderer that leaves it unset (the browser) gets the install
 * command shown instead of a button.
 */
export type PluginInstaller = (ref: string) => Promise<{ ok: boolean; error?: string }>;

let installer: PluginInstaller | null = null;

export function setPluginInstaller(next: PluginInstaller | null): void {
  installer = next;
}

export function getPluginInstaller(): PluginInstaller | null {
  return installer;
}
