import { expect, test } from "bun:test";
import { CloudApiSocket } from "./socket";
import type { TapeFeedEvent } from "./tape";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Tape socket did not settle");
    await Bun.sleep(10);
  }
}
test("tape subscriptions share a socket, replay after auth reset and release the last listener", async () => {
  const frames: Array<{ type: string; symbol: string; exchange: string }> = [];
  const peers: Array<{ send(value: string): unknown; close(): unknown }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("Upgrade required", { status: 426 }); },
    websocket: { open(peer) { peers.push(peer); }, message(_peer, raw) { frames.push(JSON.parse(String(raw))); } },
  });
  const socket = new CloudApiSocket({ getBaseUrl: () => `http://127.0.0.1:${server.port}`, getSocketAuthToken: () => null,
    hasSessionCredential: () => false, hasVerifiedUser: () => false, isUsingWebSocketToken: () => false,
    clearWebSocketTokenForFallback: () => false, markCurrentUserUnverified() {}, updateCurrentUserFromSocket() {} });
  const first: TapeFeedEvent[] = [], second: TapeFeedEvent[] = [];
  try {
    const closeFirst = socket.subscribeTape("aapl", "NASDAQ", (event) => first.push(event));
    const closeSecond = socket.subscribeTape("AAPL", "NASDAQ", (event) => second.push(event));
    await until(() => frames.length === 1);
    expect(frames[0]).toEqual({ type: "tape.subscribe", symbol: "AAPL", exchange: "NASDAQ" });
    peers[0]!.send(JSON.stringify({ type: "tape.snapshot", data: { symbol: "MSFT", exchange: "NASDAQ" } }));
    peers[0]!.send(JSON.stringify({ type: "tape.snapshot", data: { symbol: "AAPL", exchange: "NASDAQ" } }));
    await until(() => first.length > 0 && second.length > 0);
    expect(first).toHaveLength(1); expect(second).toHaveLength(1);
    closeFirst();
    socket.syncAuthState({ reconnect: true });
    await until(() => frames.filter((frame) => frame.type === "tape.subscribe").length === 2);
    expect(second.at(-1)?.type).toBe("reset");
    expect(first).toHaveLength(1);
    peers.at(-1)!.close();
    await until(() => second.at(-1)?.type === "disconnected");
    closeSecond();
    const count = peers.length;
    await Bun.sleep(1100);
    expect(peers).toHaveLength(count);
  } finally { socket.dispose(); server.stop(true); }
});
