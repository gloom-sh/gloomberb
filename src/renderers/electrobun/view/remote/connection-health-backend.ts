import type { ConnectionHealthRegistry } from "../../../../core/connection-health";
import { CONNECTION_HEALTH_CAPABILITY_ID } from "../../../../plugins/builtin/connections";
import { backendRequest, onCapabilityEvent } from "../backend-rpc";
import { connectRemoteConnectionHealth } from "./connection-health";

const SUBSCRIPTION_ID = "connection-health";

export function connectBackendConnectionHealth(health: ConnectionHealthRegistry): () => void {
  return connectRemoteConnectionHealth(health, {
    subscribe: () => backendRequest("capability.subscribe", {
      subscriptionId: SUBSCRIPTION_ID,
      capabilityId: CONNECTION_HEALTH_CAPABILITY_ID,
      operationId: "subscribe",
      payload: {},
    }),
    unsubscribe: () => backendRequest("capability.unsubscribe", { subscriptionId: SUBSCRIPTION_ID }),
    onEvent: (listener) => onCapabilityEvent(SUBSCRIPTION_ID, (message) => listener(message.event)),
  });
}
