import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  ConnectionHealthRegistry,
  GLOOM_CLOUD_SOCKET_CONNECTION_ID,
  type ConnectionHealthStatus,
} from "../core/connection-health";
import { CloudApiSocket, SOCKET_CONNECT_TIMEOUT_MS, SOCKET_PING_ANSWER_MS, SOCKET_QUIET_PING_MS } from "./socket";
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

// A half-open link (a laptop that slept, a network that changed) left prices
// frozen for over a minute: nothing noticed a connection that stopped
// answering, or one that never finished opening.
describe("CloudApiSocket on a link that stops answering", () => {
  test("a connection that never opens is given up after ten seconds and tried again", () => {
    jest.useFakeTimers();
    const sockets = installStrictWebSocket();
    const health = healthWithSocketSource();
    const socket = new CloudApiSocket(createTestSocketDeps(), health);
    try {
      socket.subscribeQuotes([{ symbol: "AAPL" }], () => {});
      jest.advanceTimersByTime(SOCKET_CONNECT_TIMEOUT_MS - 1);
      expect(sockets[0]!.closeCalls).toBe(0);
      jest.advanceTimersByTime(1);
      expect(sockets[0]!.closeCalls).toBe(1);
      expect(health.getSnapshot().sources[0]).toMatchObject({ socketState: "error", currentDetail: "Connecting timed out" });
      jest.advanceTimersByTime(1_500);
      expect(sockets).toHaveLength(2);
    } finally {
      socket.dispose();
    }
  });

  test("a quiet connection is pinged, kept while it answers, and dropped and opened again once it goes silent", () => {
    jest.useFakeTimers();
    const sockets = installStrictWebSocket();
    const health = healthWithSocketSource();
    const details: string[] = [];
    health.subscribe(() => {
      const source = health.getSnapshot().sources[0];
      if (source?.socketState === "error") details.push(source.currentDetail ?? "");
    });
    let answered = 0;
    const socket = new CloudApiSocket(createTestSocketDeps({ onServiceAnswered: () => { answered += 1; } }), health);
    try {
      socket.subscribeQuotes([{ symbol: "AAPL" }], () => {});
      const first = sockets[0]!;
      first.open();
      first.receive({ type: "ready", features: [] });
      // Opening and every frame say the service answers.
      expect(answered).toBe(2);

      jest.advanceTimersByTime(SOCKET_QUIET_PING_MS + 2_500);
      expect(first.sent).toContainEqual({ type: "ping" });
      first.receive({ type: "pong" });
      jest.advanceTimersByTime(SOCKET_QUIET_PING_MS);
      expect(first.closeCalls).toBe(0);

      // The next ping goes unanswered: the link is half open, and is dropped and opened again.
      expect(first.sent.filter((frame) => (frame as { type?: string }).type === "ping")).toHaveLength(2);
      jest.advanceTimersByTime(SOCKET_PING_ANSWER_MS + 2_500 + 1_500);
      expect(first.closeCalls).toBe(1);
      expect(details).toEqual(["No answer from the stream"]);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      expect(sockets[1]!.sent).toContainEqual({ type: "market.subscribe", symbols: [{ symbol: "AAPL", exchange: "" }] });
    } finally {
      socket.dispose();
    }
  });

  // A hidden tab runs its timers late, and a laptop wakes with a clock far
  // ahead: the late check found a working connection silent and dropped it.
  test("a check that runs late pings first, and keeps a connection that answers", () => {
    jest.useFakeTimers();
    const sockets = installStrictWebSocket();
    const health = healthWithSocketSource();
    const socket = new CloudApiSocket(createTestSocketDeps(), health);
    const timerClock = Date.now.bind(Date);
    const clockAhead = spyOn(Date, "now");
    try {
      socket.subscribeQuotes([{ symbol: "AAPL" }], () => {});
      const first = sockets[0]!;
      first.open();
      first.receive({ type: "ready", features: [] });

      // The next check runs a minute after the last frame.
      clockAhead.mockImplementation(() => timerClock() + 60_000);
      jest.advanceTimersByTime(2_500);
      expect(first.closeCalls).toBe(0);
      expect(first.sent).toContainEqual({ type: "ping" });
      first.receive({ type: "pong" });
      jest.advanceTimersByTime(SOCKET_PING_ANSWER_MS);
      expect(first.closeCalls).toBe(0);
      expect(sockets).toHaveLength(1);
    } finally {
      clockAhead.mockRestore();
      socket.dispose();
    }
  });
});
