import type { PluginCapability } from "../../../capabilities";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { PluginModule } from "../plugin-module";
import { ConnectionsPane } from "./pane";

export const CONNECTION_HEALTH_CAPABILITY_ID = "application.connection-health";

function connectionHealthCapability(health: ConnectionHealthRegistry): PluginCapability {
  return {
    id: CONNECTION_HEALTH_CAPABILITY_ID,
    kind: "plugin-service",
    name: "Connection Health",
    operations: {
      snapshot: {
        kind: "read",
        rendererSafe: true,
        handler: () => health.getSnapshot(),
      },
      subscribe: {
        kind: "stream",
        rendererSafe: true,
        subscribe: (_input, emit) => {
          const publish = () => emit(health.getSnapshot());
          publish();
          return health.subscribe(publish);
        },
      },
    },
  };
}

export const connectionsModule: PluginModule = {
  panes: [{
    id: "connections",
    name: "Connections",
    icon: "C",
    component: ConnectionsPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 80, height: 24 },
    portableShare: {
      private: { params: true, settings: true, state: true },
    },
  }],
  paneTemplates: [{
    id: "connections-pane",
    paneId: "connections",
    label: "Connections",
    description: "Inspect live request and socket health.",
    keywords: ["connections", "health", "providers", "latency", "status"],
    shortcut: { prefix: "CONN" },
  }],
  setup(ctx) {
    ctx.registerCapability(connectionHealthCapability(ctx.connectionHealth));
  },
};
