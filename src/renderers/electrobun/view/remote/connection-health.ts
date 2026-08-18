import type {
  ConnectionHealthRegistry,
  ConnectionHealthSnapshot,
} from "../../../../core/connection-health";

export interface RemoteConnectionHealthBridge {
  subscribe(): Promise<unknown>;
  unsubscribe(): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
}

function isSnapshot(value: unknown): value is ConnectionHealthSnapshot {
  return !!value
    && typeof value === "object"
    && Array.isArray((value as ConnectionHealthSnapshot).sources)
    && typeof (value as ConnectionHealthSnapshot).version === "number";
}

export function connectRemoteConnectionHealth(
  health: ConnectionHealthRegistry,
  bridge: RemoteConnectionHealthBridge,
): () => void {
  let disposed = false;
  let subscribed = false;
  let unsubscribeStarted = false;
  const unsubscribe = () => {
    if (unsubscribeStarted) return;
    unsubscribeStarted = true;
    void bridge.unsubscribe().catch(() => {});
  };
  const disposeEvents = bridge.onEvent((event) => {
    if (!disposed && isSnapshot(event)) health.replaceExternalSnapshot("backend", event);
  });

  void bridge.subscribe().then(() => {
    subscribed = true;
    if (disposed) unsubscribe();
  }).catch(() => {
    if (!disposed) health.clearExternalSnapshot("backend");
  });

  return () => {
    if (disposed) return;
    disposed = true;
    disposeEvents();
    health.clearExternalSnapshot("backend");
    if (subscribed) unsubscribe();
  };
}
