import { afterEach, expect, test } from "bun:test";
import type { BrokerAdapter, BrokerConnectionStatus, BrokerOrderListener } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { AppNotificationRequest } from "../../../types/plugin";
import type { BrokerOrder, BrokerTradingCapabilities } from "../../../types/trading";
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
  let failing = false, trading = true;
  const calls: string[] = [];
  const connected: BrokerConnectionStatus = { state: "connected", updatedAt: 0 };
  const broker: BrokerAdapter = {
    id: "synthetic", name: "Synthetic", configSchema: [], validate: async () => true, importPositions: async () => [],
    getStatus: () => connected, subscribeStatus: () => () => {},
    listOpenOrders: async () => { calls.push("listOpenOrders"); if (failing) throw new Error("synthetic outage"); return open; },
    getTradingCapabilities: () => ({ enabled: trading }) as BrokerTradingCapabilities,
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
    setFailing: (value: boolean) => { failing = value; }, setTrading: (value: boolean) => { trading = value; },
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

test("an order the broker cannot confirm stays, unconfirmed, until its status answers", async () => {
  const f = setup();
  const release = f.feed.hold(f.broker, instance);
  await settle();
  f.setOpen([]);
  f.feed.refresh(instance.id);
  await settle();
  expect(f.feed.snapshot(instance.id).orders.map((value) => value.status)).toEqual(["UNKNOWN"]);
  f.setStatus(order({ status: "FILLED", filled: 10, remaining: 0, updatedAt: Date.now() }));
  f.feed.refresh(instance.id);
  await settle();
  expect(f.feed.snapshot(instance.id).orders.map((value) => value.status)).toEqual(["FILLED"]);
  release();
});

test("failed reads back off to a minute, and a profile with trading off is read but not polled", async () => {
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const timers: Array<{ delay: number; run: () => void }> = [];
  // The feed's timers are recorded, never armed; their handles are objects no real timer can be mistaken for.
  globalThis.setTimeout = ((run: () => void, delay: number) => { const timer = { delay, run }; timers.push(timer); return timer; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => { if (!timers.includes(handle as never)) realClearTimeout(handle as never); }) as typeof clearTimeout;
  try {
    const f = setup();
    const release = f.feed.hold(f.broker, instance);
    await settle();
    const next = async () => { timers.at(-1)!.run(); await settle(); return timers.at(-1)!.delay; };
    expect(timers.at(-1)!.delay).toBe(5_000);
    f.setFailing(true);
    const delays = [];
    for (let index = 0; index < 6; index++) delays.push(await next());
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    f.setFailing(false);
    expect(await next()).toBe(5_000);
    f.setTrading(false);
    const scheduled = timers.length;
    timers.at(-1)!.run();
    await settle();
    expect(timers).toHaveLength(scheduled);
    f.feed.refresh(instance.id);
    await settle();
    expect(timers).toHaveLength(scheduled);
    expect(f.calls.filter((call) => call === "listOpenOrders")).toHaveLength(10);
    // Turning trading on edits the profile, which the plugin holds again: polling resumes.
    f.setTrading(true);
    const again = f.feed.hold(f.broker, instance);
    expect(timers).toHaveLength(scheduled + 1);
    again();
    release();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("a fill or partial fill re-syncs its profile's positions once per burst; an old fill read at launch does not", async () => {
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const timers: Array<{ delay: number; run: () => void; cleared?: boolean }> = [];
  globalThis.setTimeout = ((run: () => void, delay: number) => { const timer = { delay, run }; timers.push(timer); return timer; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const timer = timers.find((value) => value === handle);
    if (timer) timer.cleared = true; else realClearTimeout(handle as never);
  }) as typeof clearTimeout;
  try {
    const f = setup({ stream: true });
    const synced: string[] = [];
    let finish: (() => void) | undefined;
    f.feed.setPositionSync((instanceId) => { synced.push(instanceId); return new Promise<void>((resolve) => { finish = resolve; }); });
    // The polling timers are seconds apart; the position sync's is the short one.
    const pending = () => timers.filter((timer) => !timer.cleared && timer.delay <= 2_000);
    const runPending = async () => { for (const timer of pending()) { timer.cleared = true; timer.run(); } await settle(); };
    // At launch, a working order that filled in part an hour ago: the startup import has those positions.
    f.setOpen([order(), order({ orderId: 9, brokerOrderId: "synthetic-9", status: "PARTIALLY_FILLED", filled: 2, remaining: 8, updatedAt: Date.now() - 3_600_000 })]);
    const release = f.feed.hold(f.broker, instance);
    await settle();
    f.live(true);
    await settle();
    expect(pending()).toHaveLength(0);
    // A partial fill, then the rest: one sync, for this profile.
    f.push(order({ status: "PARTIALLY_FILLED", filled: 4, remaining: 6, updatedAt: Date.now() }));
    f.push(order({ status: "FILLED", filled: 10, remaining: 0, updatedAt: Date.now() }));
    expect(pending()).toHaveLength(1);
    await runPending();
    expect(synced).toEqual([instance.id]);
    // A placement the broker answered filled, during that sync: it syncs once more after it, not alongside it.
    f.feed.note(instance.id, order({ orderId: 10, brokerOrderId: "synthetic-10", action: "SELL", status: "FILLED", filled: 10, remaining: 0, updatedAt: Date.now() }));
    await runPending();
    expect(synced).toEqual([instance.id]);
    finish!();
    await settle();
    expect(synced).toEqual([instance.id, instance.id]);
    finish!();
    await settle();
    // A report that fills nothing more syncs nothing.
    f.push(order({ status: "FILLED", filled: 10, remaining: 0, updatedAt: Date.now() }));
    expect(pending()).toHaveLength(0);
    expect(synced).toHaveLength(2);
    release();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
