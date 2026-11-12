import { afterEach, expect, test } from "bun:test";
import { CloudApiSocket } from "./socket";
import type { ScannerFeedEvent } from "./types";
import { createTestSocketDeps, installTestWebSocket } from "../test-support/cloud-api";

const originalWebSocket = globalThis.WebSocket;
let socket: CloudApiSocket | null = null;

afterEach(() => {
  socket?.dispose();
  socket = null;
  globalThis.WebSocket = originalWebSocket;
});

test("a scanner pane opened mid-stream starts from the latest payload, and the payload goes with the last pane", () => {
  const sockets = installTestWebSocket(0);
  socket = new CloudApiSocket(createTestSocketDeps());
  const first: ScannerFeedEvent[] = [];
  const stopFirst = socket.subscribeScanner("hilo", (event) => first.push(event));
  const ws = sockets[0]!;
  ws.open();
  expect(ws.sent).toEqual([{ type: "scanner.subscribe", scanner: "hilo" }]);
  ws.receive({ type: "scanner.hilo", highs: ["AAPL"] });
  expect(first).toEqual([{ type: "data", payload: { highs: ["AAPL"] } }]);

  const second: ScannerFeedEvent[] = [];
  const stopSecond = socket.subscribeScanner("hilo", (event) => second.push(event));
  expect(second).toEqual([{ type: "data", payload: { highs: ["AAPL"] } }]);
  ws.receive({ type: "scanner.denied", scanner: "hilo" });
  expect(second.at(-1)).toEqual({ type: "denied", reason: "pro_required" });

  stopFirst();
  expect(ws.closeCalls).toBe(0);
  stopSecond();
  expect(ws.sent.at(-1)).toEqual({ type: "scanner.unsubscribe", scanner: "hilo" });
  expect(ws.closeCalls).toBe(1);

  const third: ScannerFeedEvent[] = [];
  socket.subscribeScanner("hilo", (event) => third.push(event));
  expect(third).toEqual([]);
});
