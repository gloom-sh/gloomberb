import { describe, expect, test } from "bun:test";
import {
  ConnectionHealthRegistry,
  GLOOM_CLOUD_SOCKET_CONNECTION_ID,
  type ConnectionHealthStatus,
} from "../core/connection-health";
import { CloudApiSocket } from "./socket";

function waitForStatus(
  health: ConnectionHealthRegistry,
  status: ConnectionHealthStatus,
): Promise<void> {
  if (health.getSnapshot().sources[0]?.status === status) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${status}`));
    }, 2_000);
    const unsubscribe = health.subscribe(() => {
      if (health.getSnapshot().sources[0]?.status !== status) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

describe("CloudApiSocket connection health", () => {
  test("reports transitions from a real loopback websocket", async () => {
    let peer: ServerWebSocket<unknown> | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response("Upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          peer = socket;
        },
        message() {},
      },
    });
    const health = new ConnectionHealthRegistry();
    health.registerSource({
      id: GLOOM_CLOUD_SOCKET_CONNECTION_ID,
      name: "Gloom Cloud Stream",
      kind: "websocket",
    });
    const socket = new CloudApiSocket({
      getBaseUrl: () => `http://127.0.0.1:${server.port}`,
      getSocketAuthToken: () => null,
      hasVerifiedUser: () => false,
      isUsingWebSocketToken: () => false,
      clearWebSocketTokenForFallback: () => false,
      markCurrentUserUnverified: () => {},
      updateCurrentUserFromSocket: () => {},
    }, health);

    try {
      socket.subscribeQuotes([{ symbol: "AAPL" }], () => {});
      expect(health.getSnapshot().sources[0]).toMatchObject({
        status: "connecting",
        socketState: "connecting",
      });

      await waitForStatus(health, "connected");
      peer!.close(1000, "network lost");
      await waitForStatus(health, "disconnected");
      expect(health.getSnapshot().sources[0]).toMatchObject({
        socketState: "closed",
        currentDetail: "network lost",
      });
    } finally {
      socket.dispose();
      void server.stop(true);
    }
  });
});
