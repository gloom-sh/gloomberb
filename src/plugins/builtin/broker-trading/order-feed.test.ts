import { afterEach, expect, test } from "bun:test";
import type { BrokerAdapter, BrokerConnectionStatus, BrokerOrderListener } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { AppNotificationRequest } from "../../../types/plugin";
import type { BrokerOrder } from "../../../types/trading";
import { BrokerOrderFeed } from "./order-feed";

const instance: BrokerInstanceConfig = { id: "synthetic-profile", brokerType: "synthetic", label: "Synthetic", config: {} };
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const feeds: BrokerOrderFeed[] = [];
afterEach(() => { for (const feed of feeds.splice(0)) feed.clear(); });

function order(changes: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    orderId: 7, brokerOrderId: "synthetic-7", accountId: "SYNTH-SIM", brokerInstanceId: instance.id, status: "NEW", action: "BUY", orderType: "LMT",
    quantity: 10, filled: 0, remaining: 10, limitPrice: 100, updatedAt: Date.now() - 1_000,
    contract: { brokerId: "synthetic", brokerInstanceId: instance.id, symbol: "AAPL", secType: "STK", currency: "USD" }, ...changes,
  };
}

function setup(options: { stream?: boolean } = {}) {
  let open: BrokerOrder[] = [order()];
  let status: BrokerOrder | null = null;
  let stream: BrokerOrderListener | undefined;
  const calls: string[] = [];
  const connected: BrokerConnectionStatus = { state: "connected", updatedAt: 0 };
  const broker: BrokerAdapter = {
    id: "synthetic", name: "Synthetic", configSchema: [], validate: async () => true, importPositions: async () => [],
    getStatus: () => connected, subscribeStatus: () => () => {},
    listOpenOrders: async () => { calls.push("listOpenOrders"); return open; },
    getOrderStatus: async () => { calls.push("getOrderStatus"); return status; },
    ...(options.stream ? { subscribeOrders: (_profile: BrokerInstanceConfig, listener: BrokerOrderListener) => { stream = listener; return () => { stream = undefined; }; } } : {}),
  };
  const toasts: AppNotificationRequest[] = [];
  const feed = new BrokerOrderFeed();
  feeds.push(feed);
  feed.setNotifier((notification) => toasts.push(notification));
  return {
    feed, broker, calls, toasts, push: (value: BrokerOrder) => stream!.order(value), live: (value: boolean) => stream!.live?.(value),
    setOpen: (value: BrokerOrder[]) => { open = value; }, setStatus: (value: BrokerOrder | null) => { status = value; },
  };
}

test("a working order read at launch says nothing; its fill and an end found by status each toast once", async () => {
  const f = setup();
  const release = f.feed.hold(f.broker, instance);
  await settle();
  expect(f.feed.snapshot(instance.id).orders.map((value) => value.status)).toEqual(["NEW"]);
  expect(f.toasts).toEqual([]);
  f.setOpen([order({ status: "PARTIALLY_FILLED", filled: 4, remaining: 6, updatedAt: Date.now() })]);
  f.feed.refresh(instance.id);
  await settle();
  f.feed.refresh(instance.id);
  await settle();
  expect(f.toasts.map((toast) => toast.title)).toEqual(["Partial fill"]);
  // Gone from the open list: only the broker's status read says it was cancelled, not filled.
  f.setOpen([]);
  f.setStatus(order({ status: "CANCELED", filled: 4, remaining: 0, updatedAt: Date.now() }));
  f.feed.refresh(instance.id);
  await settle();
  expect(f.calls.filter((call) => call === "getOrderStatus")).toHaveLength(1);
  expect(f.toasts.map((toast) => toast.title)).toEqual(["Partial fill", "Order cancelled"]);
  expect(f.feed.snapshot(instance.id).fills).toBe(1);
  release();
});

test("pushed changes win over an older read, and an order the ticket announced is not toasted again", async () => {
  const f = setup({ stream: true });
  const release = f.feed.hold(f.broker, instance);
  await settle();
  f.live(true);
  await settle();
  expect(f.feed.snapshot(instance.id).live).toBe(true);
  const filled = order({ status: "FILLED", filled: 10, remaining: 0, avgFillPrice: 99.5, updatedAt: Date.now() });
  f.push(filled);
  expect(f.toasts.map((toast) => toast.title)).toEqual(["Order filled"]);
  expect(f.toasts[0]!.body).toBe("Buy 10 AAPL limit 100 · 10 filled at 99.5");
  // A read that started before the push still lists it working.
  f.feed.refresh(instance.id);
  await settle();
  expect(f.feed.snapshot(instance.id).orders.map((value) => value.status)).toEqual(["FILLED"]);
  f.feed.note(instance.id, order({ orderId: 8, brokerOrderId: "synthetic-8", status: "FILLED", filled: 10, remaining: 0, updatedAt: Date.now() }));
  f.push(order({ orderId: 8, brokerOrderId: "synthetic-8", status: "FILLED", filled: 10, remaining: 0, updatedAt: Date.now() }));
  expect(f.toasts).toHaveLength(1);
  release();
});
