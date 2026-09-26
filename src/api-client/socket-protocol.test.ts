import { afterEach, expect, test } from "bun:test";
import { CloudApiSocket } from "./socket";
import { getServerClockOffsetMs, resetServerClockForTests } from "../market-data/quotes/clock";
import type { CloudQuotePayload, QuoteStreamTarget } from "./types";
import { createTestSocketDeps, installTestWebSocket, type TestWebSocket } from "../test-support/cloud-api";

const originalWebSocket = globalThis.WebSocket;
let sockets: TestWebSocket[] = [];

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  resetServerClockForTests();
});

function createSocket() {
  sockets = installTestWebSocket(0);
  const socket = new CloudApiSocket(createTestSocketDeps());
  const received: Array<{ target: QuoteStreamTarget; quote: CloudQuotePayload }> = [];
  socket.subscribeQuotes(
    [{ symbol: "AAPL", exchange: "NASDAQ" }, { symbol: "MSFT", exchange: "NASDAQ" }],
    (target, quote) => received.push({ target, quote }),
  );
  const ws = sockets.at(-1)!;
  ws.open();
  return { socket, ws, received };
}

test("opts into batched quotes only when the server offers them, once per connection", () => {
  const { ws } = createSocket();
  ws.receive({ type: "ready", user: null, marketTier: "anonymous" });
  expect(ws.sent.some((message) => message.type === "client.features")).toBe(false);

  ws.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch", "future.thing"] });
  ws.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch"] });
  expect(ws.sent.filter((message) => message.type === "client.features"))
    .toEqual([{ type: "client.features", features: ["market.batch"] }]);
});

test("dispatches every item of a batched frame like a single quote frame", () => {
  const { ws, received } = createSocket();
  ws.receive({
    type: "market.quotes",
    at: Date.now(),
    quotes: [
      { symbol: "AAPL", exchange: "NASDAQ", quote: { symbol: "AAPL", price: 231 }, delivery: "stream", stale: false },
      { symbol: "TSLA", exchange: "NASDAQ", quote: { symbol: "TSLA", price: 400 }, delivery: "stream", stale: false },
      { symbol: "MSFT", exchange: "NASDAQ", quote: { symbol: "MSFT", price: 510 }, delivery: "poll", stale: true },
      { symbol: "BROKEN" },
    ],
  });
  ws.receive({ type: "market.quote", symbol: "AAPL", exchange: "NASDAQ", quote: { symbol: "AAPL", price: 232 }, delivery: "stream" });

  expect(received.map(({ target, quote }) => [target.symbol, quote.price, quote.delivery, quote.stale])).toEqual([
    ["AAPL", 231, "stream", false],
    ["MSFT", 510, "poll", true],
    ["AAPL", 232, "stream", undefined],
  ]);
});

test("measures how far the server clock runs ahead from ready and batch stamps", () => {
  const { ws } = createSocket();
  ws.receive({ type: "ready", user: null, serverTime: Date.now() + 4_000, features: [] });
  expect(getServerClockOffsetMs()).toBeGreaterThan(3_500);
  ws.receive({ type: "market.quotes", at: Date.now() + 6_000, quotes: [] });
  expect(getServerClockOffsetMs()).toBeGreaterThan(5_500);
});
