import { afterEach, expect, test } from "bun:test";
import { CloudApiSocket } from "../../../../api-client/socket";
import type { RemoteControlRequest } from "../../../../remote/types";
import { createTestSocketDeps, installTestWebSocket } from "../../../../test-support/cloud-api";
import type { PluginPersistence } from "../../../../types/plugin";
import { TerminalRelayClient } from "./client";
import { TerminalRelayEngine } from "./engine";
import { TerminalRelayGrants } from "./grants";

const originalWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

function persistence(): PluginPersistence {
  const state = new Map<string, unknown>();
  return {
    getState: <T,>(key: string) => (state.get(key) as T) ?? null,
    setState: (key, value) => { state.set(key, value); },
    deleteState: (key) => { state.delete(key); },
    getResource: () => null,
    setResource: () => { throw new Error("unused"); },
    deleteResource: () => {},
  };
}

test("round trip over the Cloud socket: negotiate, announce, run a relayed call, answer", async () => {
  const sockets = installTestWebSocket(0);
  const socket = new CloudApiSocket(createTestSocketDeps({ hasSessionCredential: () => true, hasVerifiedUser: () => true }));
  const handled: RemoteControlRequest[] = [];
  const grants = new TerminalRelayGrants();
  grants.attach(persistence());
  grants.decide("key:k1", "Codex", "always");
  const engine = new TerminalRelayEngine({
    handle: async (request) => {
      handled.push(request);
      return { ok: true, data: { focusedPaneId: "quote:main" } };
    },
    send: (frame) => socket.sendFrame(frame),
    grants,
    prompts: { askApproval: async () => "deny", askConfirmation: async () => "deny" },
  });
  const client = new TerminalRelayClient(socket, engine, () => ({ id: "a".repeat(32), kind: "tui", name: "studio", appVersion: "9.9.9" }));
  const stop = client.start();
  const ws = sockets.at(-1)!;
  ws.open();

  // An older server offers nothing: the app stays quiet.
  ws.receive({ type: "ready", user: { id: "u1" }, features: [] });
  expect(ws.sent.some((frame) => frame.type === "terminal.hello")).toBe(false);

  // A new connection (here: after signing in again) negotiates afresh.
  socket.syncAuthState({ reconnect: true });
  const next = sockets.at(-1)!;
  expect(next).not.toBe(ws);
  next.open();
  next.receive({ type: "ready", user: { id: "u1" }, features: ["terminal.relay"] });
  const features = next.sent.find((frame) => frame.type === "client.features");
  expect(features.features).toContain("terminal.relay");
  const hello = next.sent.find((frame) => frame.type === "terminal.hello");
  expect(hello.device).toMatchObject({ id: "a".repeat(32), kind: "tui", name: "studio", protocol: 1 });
  expect(hello.device.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["pane.show", "capability.invoke", "snapshot"]));
  expect(next.sent.indexOf(features)).toBeLessThan(next.sent.indexOf(hello));

  next.receive({ type: "terminal.call", data: { id: "call-1", tool: "pane.focus", input: { paneId: "quote:main" }, client: { id: "key:k1", name: "Codex" } } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(handled).toEqual([{ type: "call", operation: "pane.focus", input: { paneId: "quote:main" }, include: [] }]);
  expect(next.sent.find((frame) => frame.type === "terminal.result")).toMatchObject({ id: "call-1", ok: true });

  stop();
  expect(next.sent.at(-1)).toEqual({ type: "terminal.bye" });
  socket.dispose();
});
