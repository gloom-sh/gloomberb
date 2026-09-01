/**
 * Broker plugin surface (`gloomberb/broker`).
 *
 * A broker plugin needs three things the generic plugin API does not cover: the
 * account cache the app reads positions from, a resource store for cached
 * fetches, and — on the desktop — a client for reaching its own Bun-side service
 * from the view, since the renderer cannot open sockets itself.
 */
export { getBrokerRemoteClient, setBrokerRemoteClient } from "../brokers/remote-broker-adapter";
export type { BrokerRemoteClient } from "../brokers/remote-broker-adapter";
export type { ResourceStore } from "../data/resource-store";
export { resolveTickerFinancialsForInstrument } from "../market-data/coordinator";

/**
 * The app's cached-resource store, for plugins that persist fetched data across
 * restarts. Set by the host at startup and cleared on teardown.
 *
 * A plugin should treat a null store as "no cache available" and still work,
 * since it is absent before services are constructed.
 */
let pluginResourceStore: import("../data/resource-store").ResourceStore | null = null;

export function setPluginResourceStore(
  store: import("../data/resource-store").ResourceStore | null,
): void {
  pluginResourceStore = store;
}

export function getPluginResourceStore(): import("../data/resource-store").ResourceStore | null {
  return pluginResourceStore;
}
