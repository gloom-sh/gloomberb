import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../utils/debug-log";
import { BrokerOrderFeed } from "./order-feed";
import { createDemoBroker } from "./test-fixture";

test("a rejected missing-order read keeps the last report and logs no account details", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const demo = createDemoBroker();
  const feed = new BrokerOrderFeed();
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "broker-trading.order-feed") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const order = await demo.adapter.placeOrder!(demo.instance, demo.draft);
    demo.adapter.listOpenOrders = async () => [order];
    const first = Promise.withResolvers<void>();
    const unsubscribe = feed.subscribe(() => { if (feed.snapshot(demo.instance.id).loaded) first.resolve(); });
    feed.hold(demo.adapter, demo.instance);
    await first.promise;
    demo.adapter.listOpenOrders = async () => [];
    demo.adapter.getOrderStatus = async () => { throw new Error("token=private account=private"); };
    const next = Promise.withResolvers<void>();
    const unlisten = feed.subscribe(() => next.resolve());
    feed.refresh(demo.instance.id);
    await next.promise;
    expect(feed.snapshot(demo.instance.id).orders).toEqual([order]);
    expect(logged).toEqual([["warn", expect.stringMatching(/^Read missing broker order status failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
    unsubscribe();
    unlisten();
  } finally {
    feed.clear();
    stop();
    now.mockRestore();
  }
});
