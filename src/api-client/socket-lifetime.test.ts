import { afterEach, expect, test } from "bun:test";
import { apiClient } from "./index";
import { installTestWebSocket, type TestWebSocket } from "../test-support/cloud-api";

const originalWebSocket = globalThis.WebSocket;
let sockets: TestWebSocket[] = [];

afterEach(() => {
  apiClient.dispose();
  apiClient.setSessionToken(null);
  globalThis.WebSocket = originalWebSocket;
});

function signIn(id: string, plan: "free" | "pro") {
  apiClient.setSessionToken(`controlled-${id}`);
  apiClient.restoreCachedUser({ id, emailVerified: true, plan, effectivePlan: plan });
}

function start() {
  apiClient.dispose();
  sockets = installTestWebSocket(0);
  signIn("first-user", "free");
  const quotes: number[] = [];
  apiClient.subscribeQuotes([{ symbol: "CONTROL", exchange: "NASDAQ" }], (_target, quote) => quotes.push(quote.price));
  return { retired: sockets[0]!, quotes };
}

function retiredMessages(socket: TestWebSocket) {
  socket.receive({ type: "ready", user: { id: "first-user", emailVerified: true, plan: "free", effectivePlan: "free" } });
  socket.receive({ type: "auth.unverified" });
  socket.receive({ type: "market.quote", symbol: "CONTROL", exchange: "NASDAQ", quote: { price: 1 } });
}

test("a replaced socket cannot revoke upgraded access or deliver an obsolete quote", () => {
  const { retired, quotes } = start();
  signIn("first-user", "pro");
  const active = sockets.at(-1)!;
  expect(retired.closeCalls).toBe(1);
  retiredMessages(retired);
  expect(apiClient.getCurrentUser()).toMatchObject({ id: "first-user", emailVerified: true, plan: "pro", effectivePlan: "pro" });
  expect(quotes).toEqual([]);
  expect(active.closeCalls).toBe(0);
  active.receive({ type: "ready", user: { name: "Current profile" } });
  active.receive({ type: "market.quote", symbol: "CONTROL", exchange: "NASDAQ", quote: { price: 25 } });
  expect(apiClient.getCurrentUser()?.name).toBe("Current profile");
  expect(quotes).toEqual([25]);
});

test("a disposed socket cannot replace a later account or feed its new quote listener", () => {
  const { retired } = start();
  apiClient.dispose();
  signIn("second-user", "pro");
  const quotes: number[] = [];
  apiClient.subscribeQuotes([{ symbol: "CONTROL", exchange: "NASDAQ" }], (_target, quote) => quotes.push(quote.price));
  const active = sockets.at(-1)!;
  retiredMessages(retired);
  expect(apiClient.getCurrentUser()).toMatchObject({ id: "second-user", emailVerified: true, plan: "pro", effectivePlan: "pro" });
  expect(quotes).toEqual([]);
  expect(active.closeCalls).toBe(0);
  active.receive({ type: "market.quote", symbol: "CONTROL", exchange: "NASDAQ", quote: { price: 30 } });
  expect(quotes).toEqual([30]);
});
