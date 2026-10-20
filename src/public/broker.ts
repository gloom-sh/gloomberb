/**
 * Broker plugin surface (`gloomberb/broker`).
 *
 * A broker plugin needs what the generic plugin API does not cover: the account
 * cache the app reads positions from, and, on the desktop, a client for reaching
 * its own Bun-side service from the view, since the renderer cannot open sockets
 * itself. Cached fetches go through `createPluginCache` from `gloomberb/utils`.
 */
export { getBrokerRemoteClient, setBrokerRemoteClient } from "../brokers/remote-broker-adapter";
/** A broker connection held by the user's Gloom Cloud account, confined to `/brokers/{broker}`. */
export { cloudBrokerLink } from "../brokers/cloud-broker-link";
export type { CloudBrokerLink } from "../brokers/cloud-broker-link";
/**
 * Placeholder a broker shows instead of a stored secret, so an edited profile
 * can tell "unchanged" from "cleared". Broker plugins that persist a derived
 * credential need the host's exact string for the round trip to work.
 */
export { PRESERVED_PASSWORD_HINT } from "../brokers/profile-form";
export type { BrokerRemoteClient } from "../brokers/remote-broker-adapter";
export type { ResourceStore } from "../data/resource-store";
export { resolveTickerFinancialsForInstrument } from "../market-data/coordinator";

/**
 * This host's Cloud sync honors `BrokerAdapter.localMarketData`. A broker whose market data must
 * not reach Gloom Cloud reads it to tell an older host, which would sync its quotes and where it
 * still has to ask for Cloud to be off: `import * as broker from "gloomberb/broker"`, then
 * `broker.LOCAL_BROKER_MARKET_DATA === true`.
 */
export const LOCAL_BROKER_MARKET_DATA = true;

/**
 * The app's cached-resource store. Set by the host at startup and cleared on
 * teardown; null before services are constructed.
 */
let pluginResourceStore: import("../data/resource-store").ResourceStore | null = null;

/** @deprecated Host wiring for `getPluginResourceStore`; plugins never call it. */
export function setPluginResourceStore(
  store: import("../data/resource-store").ResourceStore | null,
): void {
  pluginResourceStore = store;
}

/**
 * @deprecated Use `createPluginCache` from `gloomberb/utils`, which keeps the
 * last good payload in the plugin's own persistence with a TTL.
 */
export function getPluginResourceStore(): import("../data/resource-store").ResourceStore | null {
  return pluginResourceStore;
}
