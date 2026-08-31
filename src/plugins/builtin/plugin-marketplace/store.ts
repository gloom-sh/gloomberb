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
