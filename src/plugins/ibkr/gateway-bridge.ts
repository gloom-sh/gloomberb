import type { BrokerConnectionStatus } from "../../types/broker";
import type { BrokerInstanceConfig } from "../../types/config";
// Type-only, so it is erased at build time and creates no runtime dependency on
// the Gateway plugin. It is the contract the two sides share; when Gateway moves
// to its own repository this becomes a types-only peer dependency.
import type { IbkrGatewayServiceFacade } from "../ibkr-gateway/gateway/service";

/**
 * The seam between IBKR Flex and IBKR Gateway.
 *
 * Flex talks to a hosted HTTPS statement service and runs anywhere. Gateway
 * opens a raw TCP socket to a local TWS instance, so it can never run in a
 * browser. They are separate plugins for that reason, but they are one broker:
 * a user has a single "Interactive Brokers" profile whose `connectionMode`
 * decides which side services it.
 *
 * Splitting them across two broker ids would orphan every saved broker instance
 * and its stored credentials, so instead the Flex plugin owns the broker id and
 * Gateway registers itself here when installed. With no Gateway plugin present,
 * a Gateway-mode profile reports why it is inert rather than failing obscurely.
 *
 * The bridge hands back the gateway service rather than mirroring its ~20
 * methods: the adapter's gateway calls stay exactly as they were, and the two
 * plugins share one type instead of a hand-copied interface that drifts.
 */

export interface IbkrGatewayBridge {
  refresh(instance: BrokerInstanceConfig): Promise<void>;
  getService(instanceId: string): IbkrGatewayServiceFacade;
  removeInstance(instanceId: string): Promise<void>;
  getStatus(instanceId: string): BrokerConnectionStatus;
  subscribeStatus(instanceId: string, listener: () => void): () => void;
}

let bridge: IbkrGatewayBridge | null = null;

export function setIbkrGatewayBridge(next: IbkrGatewayBridge | null): void {
  bridge = next;
}

export function getIbkrGatewayBridge(): IbkrGatewayBridge | null {
  return bridge;
}

export const GATEWAY_UNAVAILABLE_MESSAGE =
  "Install the IBKR Gateway plugin to use a Gateway or TWS profile.";

/** Status shown for a Gateway profile when the Gateway plugin is not installed. */
export function gatewayUnavailableStatus(): BrokerConnectionStatus {
  return {
    state: "error",
    message: GATEWAY_UNAVAILABLE_MESSAGE,
    updatedAt: Date.now(),
  };
}

export function requireGatewayBridge(): IbkrGatewayBridge {
  if (!bridge) throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
  return bridge;
}

/** The gateway service for an instance, or `null` when Gateway is not installed. */
export function gatewayServiceFor(instanceId: string): IbkrGatewayServiceFacade | null {
  return bridge?.getService(instanceId) ?? null;
}
