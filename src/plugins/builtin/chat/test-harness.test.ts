import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { cleanupChatTest, createController, installChatApiTestDefaults } from "./test-harness";

const originalWebSocket = globalThis.WebSocket;

afterEach(async () => {
  await cleanupChatTest(undefined);
  apiClient.dispose();
  apiClient.setSessionToken(null);
  globalThis.WebSocket = originalWebSocket;
});

test("cleaning up a chat fixture cannot reconnect its channel under the next test's session", async () => {
  apiClient.dispose();
  installChatApiTestDefaults();
  const sockets: Array<{ readyState: number }> = [];
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
    readyState = 0;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(url: string) {
      sockets.push(this);
      // Reproduce the synthetic credential rejection locally, without a socket.
      if (url.includes("next-controlled-session")) queueMicrotask(() => {
        if (this.readyState !== 3) this.onmessage?.({ data: JSON.stringify({ type: "auth.unverified" }) });
      });
    }
    send() {}
    close() { this.readyState = 3; }
  } as unknown as typeof WebSocket;

  const controller = createController({ sessionToken: "chat-controlled-session" });
  controller.ensureConnection("everyone");
  const replacement = createController({ sessionToken: "chat-controlled-session" });
  replacement.ensureConnection("everyone");
  expect(sockets).toHaveLength(1);
  await cleanupChatTest(undefined);
  expect(sockets[0]!.readyState).toBe(3);

  apiClient.setSessionToken("next-controlled-session");
  apiClient.restoreCachedUser({ id: "next-test", emailVerified: true, plan: "pro" });
  await Promise.resolve();
  expect(sockets).toHaveLength(1);
  expect(apiClient.getCurrentUser()?.emailVerified).toBe(true);
});
