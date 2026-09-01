/**
 * Broker plugin surface (`gloomberb/broker`).
 *
 * A broker plugin needs three things the generic plugin API does not cover: the
 * account cache the app reads positions from, a resource store for cached
 * fetches, and — on the desktop — a client for reaching its own Bun-side service
 * from the view, since the renderer cannot open sockets itself.
 */
export { getBrokerRemoteClient, setBrokerRemoteClient } from "../brokers/remote-broker-adapter";
export type { ResourceStore } from "../data/resource-store";
export { resolveTickerFinancialsForInstrument } from "../market-data/coordinator";
