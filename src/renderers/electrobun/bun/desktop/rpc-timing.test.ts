import { expect, test } from "bun:test";
import { lastPerfSample } from "../../../../utils/perf-marks";
import { measureRpcTraffic } from "./rpc-timing";

// An answer goes out long after its request came in, under nothing but an
// id: the name a stall report gives it comes from the request it answers.
test("each turn of a window's channel is named by the request it serves or the message it carries", () => {
  type Transport = Parameters<Parameters<typeof measureRpcTraffic>[0]["setTransport"]>[0];
  // Electrobun's channel: it takes the transport and hands it its packet handler.
  let installed: Transport = {};
  const rpc = {
    setTransport: (transport: Transport) => {
      installed = transport;
      transport.registerHandler?.(() => {});
    },
  };
  // What the webview's socket calls with each packet.
  let handler: ((packet: object) => unknown) | null = null;
  measureRpcTraffic(rpc);
  rpc.setTransport({
    send: () => {},
    registerHandler: (next) => { handler = next; },
  });
  const named = (turn: () => void) => {
    turn();
    return lastPerfSample()?.name;
  };

  expect([
    named(() => handler!({ type: "request", id: 7, method: "backend.request", params: { method: "ticker.loadAll" } })),
    named(() => handler!({ type: "request", id: 8, method: "backend.request", params: { method: "capability.invoke" } })),
    named(() => handler!({ type: "message", id: "runtime.stall", payload: {} })),
    named(() => installed.send!({ type: "message", id: "desktop.state", payload: {} })),
    named(() => installed.send!({ type: "response", id: 8, success: true, payload: {} })),
    named(() => installed.send!({ type: "response", id: 7, success: true, payload: {} })),
  ]).toEqual([
    "rpc.request.ticker.load-all",
    "rpc.request.capability.invoke",
    "rpc.message.runtime.stall",
    "rpc.send.desktop.state",
    "rpc.respond.capability.invoke",
    "rpc.respond.ticker.load-all",
  ]);
});
