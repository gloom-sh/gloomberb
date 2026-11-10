import { afterAll, expect, spyOn, test } from "bun:test";
import type { Server } from "bun";
import { CONNECTION_LOST_MESSAGE, REQUEST_TIMED_OUT_MESSAGE, RpcTimeoutError } from "../../../utils/rpc-timeout-error";
import { createBridgeHealth, createHostRoute, type HostSocket } from "./host-route";

const browserApi = import.meta.resolve("electrobun/view");
const { createRPC } = await import(new URL("../shared/rpc.ts", browserApi).href);

// The Bun process's side: answers every request, as on Windows by running a
// script in the page whether or not the page's socket is open. The page's
// messages come in over the socket or through the native bridge.
let receiveHost: (packet: unknown) => void = () => {};
let page: { __electrobun: { receiveMessageFromHost(packet: unknown): void } } & Record<string, unknown>;
const host = createRPC({ requestHandler: { "backend.request": (request: { method: string }) => ({ answered: request.method }) } });
host.setTransport({
  registerHandler: (handler: typeof receiveHost) => { receiveHost = handler; },
  send: (packet: unknown) => { queueMicrotask(() => page.__electrobun.receiveMessageFromHost(JSON.parse(JSON.stringify(packet)))); },
});

const arrivedBy: string[] = [];
let handshake: "answer" | "hang" = "hang";
const server: Server<unknown> = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, upgrading) {
    // A socket that never opens: the handshake is never answered.
    if (handshake === "hang") return new Promise<Response>(() => {});
    return upgrading.upgrade(request) ? undefined : new Response(null, { status: 400 });
  },
  websocket: {
    message(_socket, message) {
      arrivedBy.push("socket");
      receiveHost(JSON.parse(String(message)));
    },
  },
});

// Electroview reads its webview id and socket port from the page when it loads.
const originalWindow = (globalThis as { window?: unknown }).window;
page = {
  __electrobunWebviewId: 7,
  __electrobunHostSocketPort: server.port,
  __electrobunPlaintextHostSocket: true,
  __electrobun: { receiveMessageFromHost: () => {} },
  __electrobunHostBridge: {
    postMessage: (message: string) => {
      arrivedBy.push("bridge");
      queueMicrotask(() => receiveHost(JSON.parse(message)));
    },
  },
};
(globalThis as { window?: unknown }).window = page;
const { Electroview } = await import(new URL("./index.ts", browserApi).href);

afterAll(() => {
  void server.stop(true);
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting in the test.");
}

// A Windows desktop chart said "Electrobun RPC socket did not open in time."
// while quotes kept arriving: every request waited for Electroview's socket,
// which it opens once and never again, though Electroview itself sends through
// the page's native bridge whenever the socket is not open.
test("a request goes through the native bridge when the socket never opens, and after it closes", async () => {
  // Electroview logs the socket closed while connecting.
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    await askAcrossBridge();
  } finally {
    consoleError.mockRestore();
  }
});

async function askAcrossBridge(): Promise<void> {
  const rpc = Electroview.defineRPC({ maxRequestTime: 1_000, handlers: { requests: {}, messages: {} } });
  const electroview = new Electroview({ rpc });
  const route = createHostRoute({
    socket: () => electroview.hostSocket,
    nativeBridge: () => !!page.__electrobunHostBridge,
    limitMs: 100,
  });
  const ask = async (method: string) => {
    await route.ready(method);
    return rpc.request["backend.request"]({ method, payload: null });
  };

  // Electroview holds a request while its socket connects, and Electrobun
  // starts no timer for it: closing the socket that never opens sends it on.
  expect(electroview.hostSocket.readyState).toBe(WebSocket.CONNECTING);
  expect(await ask("init")).toEqual({ answered: "init" });
  expect(arrivedBy).toEqual(["bridge"]);
  expect(electroview.hostSocket.readyState).toBe(WebSocket.CLOSED);

  // A socket that opens carries requests until something closes it; then the bridge does, at once.
  handshake = "answer";
  electroview.initSocketToHost();
  await until(() => electroview.hostSocket.readyState === WebSocket.OPEN);
  arrivedBy.length = 0;
  expect(await ask("chart")).toEqual({ answered: "chart" });
  expect(arrivedBy).toEqual(["socket"]);

  electroview.hostSocket.close();
  await until(() => electroview.hostSocket.readyState === WebSocket.CLOSED);
  const startedAt = performance.now();
  expect(await ask("chart")).toEqual({ answered: "chart" });
  expect(performance.now() - startedAt).toBeLessThan(100);
  expect(arrivedBy).toEqual(["socket", "bridge"]);
}

function fakeSocket(readyState: number): HostSocket & { readyState: number; closed: number } {
  return { readyState, closed: 0, close() { this.closed += 1; this.readyState = WebSocket.CLOSED; } };
}

test("with no native bridge a request waits for the socket to open, and says only that the connection was lost when it does not", async () => {
  let clock = 0;
  let socket: ReturnType<typeof fakeSocket> | undefined = fakeSocket(WebSocket.CONNECTING);
  const route = createHostRoute({
    socket: () => socket,
    nativeBridge: () => false,
    limitMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (clock === 500 && socket) socket.readyState = WebSocket.OPEN;
    },
  });
  await route.ready("chart");
  expect(clock).toBe(500);

  socket = undefined;
  clock = 0;
  const failure = await route.ready("capability.invoke").catch((error: unknown) => error as RpcTimeoutError);
  expect(failure).toBeInstanceOf(RpcTimeoutError);
  expect(failure!.message).toBe(CONNECTION_LOST_MESSAGE);
  expect(failure!.report).toBe("No way to the Bun process for capability.invoke: socket missing, no native bridge");
  expect(clock).toBe(1_000);
});

test("a socket that opens in time is left open", async () => {
  const timers: Array<() => void> = [];
  const socket = fakeSocket(WebSocket.CONNECTING);
  const route = createHostRoute({ socket: () => socket, nativeBridge: () => true, setTimer: (callback) => timers.push(callback) });
  await route.ready("init");
  await route.ready("init");
  expect(timers).toHaveLength(1);
  socket.readyState = WebSocket.OPEN;
  timers[0]!();
  expect(socket.closed).toBe(0);
});

test("the first answer after a request went unanswered recovers the bridge, once", async () => {
  let recovered = 0;
  const health = createBridgeHealth(() => { recovered += 1; });
  const timeout = new RpcTimeoutError(REQUEST_TIMED_OUT_MESSAGE, { elapsedMs: 120_000, limitMs: 120_000, report: "RPC request timed out: chart after ~120s" });

  expect(await health.track(async () => "quote")).toBe("quote");
  expect(recovered).toBe(0);

  await expect(health.track(async () => { throw timeout; })).rejects.toBe(timeout);
  await expect(health.track(async () => { throw timeout; })).rejects.toBe(timeout);
  expect(recovered).toBe(0);
  // An error the Bun process sent back is an answer.
  await expect(health.track(async () => { throw new Error("Unknown symbol"); })).rejects.toThrow("Unknown symbol");
  expect(recovered).toBe(1);
  await health.track(async () => "quote");
  expect(recovered).toBe(1);
});
