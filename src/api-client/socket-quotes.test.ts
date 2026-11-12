import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { QUOTE_SUBSCRIPTION_FLUSH_MS, QuoteStreamSubscriptions } from "./socket-quotes";
import type { QuoteStreamTarget } from "./types";

const connection = {} as WebSocket;
let open = true;
let sent: Array<Record<string, unknown>> = [];
let quotes: QuoteStreamSubscriptions;

beforeEach(() => {
  jest.useFakeTimers();
  open = true;
  sent = [];
  quotes = new QuoteStreamSubscriptions({
    openSocket: () => (open ? connection : null),
    send: (payload) => sent.push(payload),
  });
});

afterEach(() => {
  quotes.clear();
  jest.useRealTimers();
});

function subscribe(...targets: QuoteStreamTarget[]) {
  const subscription = quotes.subscribe(targets, () => {});
  subscription.announce();
  return subscription;
}

/** What the next flush sends. */
function flush(): Array<Record<string, unknown>> {
  sent = [];
  jest.advanceTimersByTime(QUOTE_SUBSCRIPTION_FLUSH_MS);
  return sent;
}

test("changes within one flush go out together, the unsubscribe before the subscribe", () => {
  const apple = subscribe({ symbol: " aapl ", exchange: "NASDAQ" });
  subscribe({ symbol: "MSFT", exchange: "NASDAQ" }, { symbol: "MSFT", exchange: "NASDAQ", visible: true });
  expect(sent).toEqual([]);
  expect(flush()).toEqual([{
    type: "market.subscribe",
    symbols: [{ symbol: "AAPL", exchange: "NASDAQ" }, { symbol: "MSFT", exchange: "NASDAQ", visible: true }],
  }]);

  subscribe({ symbol: "TSLA", exchange: "NASDAQ" });
  apple.release();
  expect(flush()).toEqual([
    { type: "market.unsubscribe", symbols: [{ symbol: "AAPL", exchange: "NASDAQ" }] },
    { type: "market.subscribe", symbols: [{ symbol: "TSLA", exchange: "NASDAQ" }] },
  ]);
});

test("another pane on the same instrument resends it only when the merged target changes, and the last one out unsubscribes", () => {
  const first = subscribe({ symbol: "AAPL", exchange: "NASDAQ" });
  flush();
  const same = subscribe({ symbol: "AAPL", exchange: "NASDAQ" });
  expect(flush()).toEqual([]);

  const onScreen = subscribe({ symbol: "AAPL", exchange: "NASDAQ", visible: true, weight: 3 });
  expect(flush()).toEqual([{ type: "market.subscribe", symbols: [{ symbol: "AAPL", exchange: "NASDAQ", visible: true, weight: 3 }] }]);
  onScreen.release();
  expect(flush()).toEqual([{ type: "market.subscribe", symbols: [{ symbol: "AAPL", exchange: "NASDAQ" }] }]);

  same.release();
  expect(flush()).toEqual([]);
  first.release();
  expect(flush()).toEqual([{ type: "market.unsubscribe", symbols: [{ symbol: "AAPL", exchange: "NASDAQ" }] }]);
  expect(quotes.size).toBe(0);
});

test("changes made while the connection is not open are dropped, and the open sends the full set", () => {
  open = false;
  subscribe({ symbol: "AAPL", exchange: "NASDAQ" });
  const microsoft = subscribe({ symbol: "MSFT", exchange: "NASDAQ" });
  subscribe({ symbol: "BTC", exchange: "HYPERLIQUID" });
  microsoft.release();
  expect(flush()).toEqual([]);

  open = true;
  quotes.dropPending();
  quotes.replay();
  // Perpetual listings wait for a server that offers them.
  expect(sent).toEqual([{ type: "market.subscribe", symbols: [{ symbol: "AAPL", exchange: "NASDAQ" }] }]);
  quotes.setPerpsConnection(connection);
  expect(sent.at(-1)).toEqual({ type: "market.subscribe", symbols: [{ symbol: "BTC", exchange: "HYPERLIQUID" }] });
  expect(flush()).toEqual([]);
});

test("a streamed perpetual listing is sent again when its merged target changes, and unsubscribed with its last pane", () => {
  quotes.setPerpsConnection(connection);
  const board = subscribe({ symbol: "BTC", exchange: "HYPERLIQUID" });
  expect(flush()).toEqual([{ type: "market.subscribe", symbols: [{ symbol: "BTC", exchange: "HYPERLIQUID" }] }]);

  const selected = subscribe({ symbol: "BTC", exchange: "HYPERLIQUID", selected: true });
  expect(flush()).toEqual([{ type: "market.subscribe", symbols: [{ symbol: "BTC", exchange: "HYPERLIQUID", selected: true }] }]);

  selected.release();
  board.release();
  expect(flush()).toEqual([{ type: "market.unsubscribe", symbols: [{ symbol: "BTC", exchange: "HYPERLIQUID", selected: true }] }]);
});
