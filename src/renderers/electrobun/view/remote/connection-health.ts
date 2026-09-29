import type {
  ConnectionHealthRegistry,
  ConnectionHealthSnapshot,
} from "../../../../core/connection-health";
import { CONNECTION_HEALTH_CAPABILITY_ID } from "../../../../plugins/builtin/connections";
import { subscribeBackendCapability } from "../backend-rpc";

function isSnapshot(value: unknown): value is ConnectionHealthSnapshot {
  return !!value
    && typeof value === "object"
    && Array.isArray((value as ConnectionHealthSnapshot).sources)
    && typeof (value as ConnectionHealthSnapshot).version === "number";
}

/** Mirrors the connection health the Bun process tracks into this window. */
export function connectBackendConnectionHealth(health: ConnectionHealthRegistry): () => void {
  const dispose = subscribeBackendCapability({
    subscriptionId: "connection-health",
    capabilityId: CONNECTION_HEALTH_CAPABILITY_ID,
    operationId: "subscribe",
    payload: {},
    onEvent: (event) => {
      if (isSnapshot(event)) health.replaceExternalSnapshot("backend", event);
    },
    onError: () => health.clearExternalSnapshot("backend"),
  });
  return () => {
    dispose();
    health.clearExternalSnapshot("backend");
  };
}
