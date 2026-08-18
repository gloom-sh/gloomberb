import type {
  ConnectionHealthRegistry,
  ConnectionHealthSnapshot,
} from "../../../../core/connection-health";
import { CONNECTION_HEALTH_CAPABILITY_ID } from "../../../../plugins/builtin/connections";
import { backendRequest, onCapabilityEvent } from "../backend-rpc";

const SUBSCRIPTION_ID = "connection-health";

function isSnapshot(value: unknown): value is ConnectionHealthSnapshot {
  return !!value
    && typeof value === "object"
    && Array.isArray((value as ConnectionHealthSnapshot).sources)
    && typeof (value as ConnectionHealthSnapshot).version === "number";
}

export function connectRemoteConnectionHealth(health: ConnectionHealthRegistry): () => void {
  let disposed = false;
  const disposeEvents = onCapabilityEvent(SUBSCRIPTION_ID, (message) => {
    if (!disposed && isSnapshot(message.event)) {
      health.replaceExternalSnapshot("backend", message.event);
    }
  });

  void backendRequest("capability.subscribe", {
    subscriptionId: SUBSCRIPTION_ID,
    capabilityId: CONNECTION_HEALTH_CAPABILITY_ID,
    operationId: "subscribe",
    payload: {},
  }).catch(() => {
    if (!disposed) health.clearExternalSnapshot("backend");
  });

  return () => {
    disposed = true;
    disposeEvents();
    health.clearExternalSnapshot("backend");
    void backendRequest("capability.unsubscribe", { subscriptionId: SUBSCRIPTION_ID }).catch(() => {});
  };
}
