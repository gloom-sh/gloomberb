import { afterEach, describe, expect, test } from "bun:test";
import {
  ConnectionHealthRegistry,
  GLOOM_CLOUD_SOCKET_CONNECTION_ID,
} from "../core/connection-health";
import { CloudApiSocket } from "./socket";

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

class TestWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}
  send() {}
  close() {}

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }

  closeFromNetwork(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe("CloudApiSocket connection health", () => {
  test("reports real connecting, open, and closed transitions", () => {
    const sockets: TestWebSocket[] = [];
    globalThis.WebSocket = class extends TestWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;

    const health = new ConnectionHealthRegistry();
    health.registerSource({
      id: GLOOM_CLOUD_SOCKET_CONNECTION_ID,
      name: "Gloom Cloud Stream",
      kind: "websocket",
    });
    const socket = new CloudApiSocket({
      getBaseUrl: () => "https://api.gloom.sh",
      getSocketAuthToken: () => null,
      hasVerifiedUser: () => false,
      isUsingWebSocketToken: () => false,
      clearWebSocketTokenForFallback: () => false,
      markCurrentUserUnverified: () => {},
      updateCurrentUserFromSocket: () => {},
    }, health);

    socket.subscribeQuotes([{ symbol: "AAPL" }], () => {});
    expect(health.getSnapshot().sources[0]).toMatchObject({ status: "connecting", socketState: "connecting" });

    sockets[0]!.open();
    expect(health.getSnapshot().sources[0]).toMatchObject({ status: "connected", socketState: "open" });

    sockets[0]!.closeFromNetwork(1006, "network lost");
    expect(health.getSnapshot().sources[0]).toMatchObject({
      status: "disconnected",
      socketState: "closed",
      currentDetail: "network lost",
    });
    socket.dispose();
  });
});
