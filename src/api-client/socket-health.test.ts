import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  ConnectionHealthRegistry,
  GLOOM_CLOUD_SOCKET_CONNECTION_ID,
  type ConnectionHealthStatus,
} from "../core/connection-health";
import { CloudApiSocket } from "./socket";
import { createTestSocketDeps, TestWebSocket } from "../test-support/cloud-api";

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  jest.useRealTimers();
});

/** Like a browser: refuses a URL that is not absolute ws(s), so opening one throws. */
function installStrictWebSocket(): TestWebSocket[] {
  const sockets: TestWebSocket[] = [];
  class StrictWebSocket extends TestWebSocket {
    constructor(url: string) {
      if (!/^wss?:\/\//.test(url)) throw new SyntaxError(`The URL '${url}' is invalid.`);
      super(url, 0);
      sockets.push(this);
    }
  }
  globalThis.WebSocket = StrictWebSocket as unknown as typeof WebSocket;
  return sockets;
}

function healthWithSocketSource(): ConnectionHealthRegistry {
  const health = new ConnectionHealthRegistry();
  health.registerSource({
    id: GLOOM_CLOUD_SOCKET_CONNECTION_ID,
    name: "Gloom Cloud Stream",
    kind: "websocket",
  });
  return health;
}

function waitForStatus(
  health: ConnectionHealthRegistry,
  status: ConnectionHealthStatus,
): Promise<void> {
  if (health.getSnapshot().sources[0]?.status === status)
    return Promise.resolve();
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
        return server.upgrade(request)
          ? undefined
          : new Response("Upgrade required", { status: 426 });
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
    const socket = new CloudApiSocket(createTestSocketDeps({ getBaseUrl: () => `http://127.0.0.1:${server.port}` }), health);

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

  test("a base URL that is not http(s) reports an error and backs off instead of throwing", () => {
    jest.useFakeTimers();
    const sockets = installStrictWebSocket();
    const health = healthWithSocketSource();
    let failures = 0;
    health.subscribe(() => {
      if (health.getSnapshot().sources[0]?.socketState === "error") failures += 1;
    });
    // The web build's base on an opaque page, where location.origin is the string "null".
    const socket = new CloudApiSocket(createTestSocketDeps({ getBaseUrl: () => "null/api" }), health);

    try {
      expect(() => socket.subscribeQuotes([{ symbol: "AAPL" }], () => {})).not.toThrow();
      expect(sockets).toHaveLength(0);
      expect(health.getSnapshot().sources[0]).toMatchObject({ status: "error", currentDetail: expect.stringContaining("null/api") });
      expect(failures).toBe(1);

      jest.advanceTimersByTime(60_000);
      // Retried on the reconnect backoff (1s doubling to 10s, jittered), never in a tight loop.
      expect(failures).toBeGreaterThan(2);
      expect(failures).toBeLessThan(20);
      expect(sockets).toHaveLength(0);
    } finally {
      socket.dispose();
    }
  });

  test("a socket the browser refuses to construct is retried and opens once it can", () => {
    jest.useFakeTimers();
    const sockets = installStrictWebSocket();
    const open = globalThis.WebSocket;
    let refuse = true;
    globalThis.WebSocket = class extends (open as unknown as typeof TestWebSocket) {
      constructor(url: string) {
        if (refuse) throw new SyntaxError("blocked by the page");
        super(url);
      }
    } as unknown as typeof WebSocket;
    const health = healthWithSocketSource();
    const socket = new CloudApiSocket(createTestSocketDeps({ getBaseUrl: () => "https://api.example.test/api" }), health);

    try {
      expect(() => socket.subscribeQuotes([{ symbol: "AAPL" }], () => {})).not.toThrow();
      expect(health.getSnapshot().sources[0]).toMatchObject({ status: "error", currentDetail: "blocked by the page" });
      refuse = false;
      jest.advanceTimersByTime(2_000);
      expect(sockets.map((opened) => opened.url)).toEqual(["wss://api.example.test/api/cloud/ws"]);
      sockets[0]!.open();
      expect(health.getSnapshot().sources[0]).toMatchObject({ status: "connected", socketState: "open" });
    } finally {
      socket.dispose();
    }
  });
});
