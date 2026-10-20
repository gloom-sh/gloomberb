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

test("a perpetual listing reaches the server only once it offers perpetual markets", () => {
  sockets = installTestWebSocket(0);
  const socket = new CloudApiSocket(createTestSocketDeps());
  socket.subscribeQuotes([{ symbol: "AAPL", exchange: "NASDAQ" }, { symbol: "BTC", exchange: "HYPERLIQUID" }], () => {});
  const ws = sockets.at(-1)!;
  ws.open();
  const subscribed = () => ws.sent.filter((message) => message.type === "market.subscribe")
    .map((message) => (message.symbols as QuoteStreamTarget[]).map((target) => `${target.symbol}:${target.exchange}`));
  // An older server would read BTC on HYPERLIQUID as a stock.
  ws.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch"] });
  expect(subscribed()).toEqual([["AAPL:NASDAQ"]]);
  ws.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch", "market.perps"] });
  ws.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch", "market.perps"] });
  expect(subscribed()).toEqual([["AAPL:NASDAQ"], ["BTC:HYPERLIQUID"]]);

  // A reconnect may reach a server rolled back to before perpetuals: each connection is asked again.
  socket.syncAuthState({ reconnect: true });
  const next = sockets.at(-1)!;
  next.open();
  next.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch"] });
  expect(next.sent.filter((message) => message.type === "market.subscribe")
    .flatMap((message) => (message.symbols as QuoteStreamTarget[]).map((target) => target.symbol))).toEqual(["AAPL"]);
});

test("the app streams one budget of perpetual listings across every pane, those on screen first", async () => {
  sockets = installTestWebSocket(0);
  const socket = new CloudApiSocket(createTestSocketDeps());
  const coins = Array.from({ length: 70 }, (_, index) => `C${index}`);
  // A board's rows off screen, then a watchlist's rows on screen.
  socket.subscribeQuotes(coins.slice(0, 65).map((symbol) => ({ symbol, exchange: "HYPERLIQUID" })), () => {});
  const unsubscribe = socket.subscribeQuotes(coins.slice(65).map((symbol) => ({ symbol, exchange: "HYPERLIQUID", visible: true })), () => {});
  const ws = sockets.at(-1)!;
  ws.open();
  ws.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch", "market.perps"] });
  const streamed = new Set<string>();
  const replay = () => {
    streamed.clear();
    for (const message of ws.sent) {
      for (const target of (message.symbols ?? []) as QuoteStreamTarget[]) {
        if (message.type === "market.subscribe") streamed.add(target.symbol);
        if (message.type === "market.unsubscribe") streamed.delete(target.symbol);
      }
    }
    return streamed;
  };
  expect(replay().size).toBe(60);
  expect(coins.slice(65).every((symbol) => streamed.has(symbol))).toBe(true);
  expect(streamed.has("C55")).toBe(false);

  // The watchlist closes: the board's next rows take its place.
  unsubscribe();
  await Bun.sleep(50);
  expect(replay().size).toBe(60);
  expect([...streamed].sort()).toEqual(coins.slice(0, 60).sort());
});
