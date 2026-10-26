import { expect, test } from "bun:test";
import type { AppNotificationRequest, GloomPluginContext } from "../../../types/plugin";
import { createDemoBroker } from "./test-fixture";
import { brokerTradingModule } from "./index";
import { brokerOrderFeed } from "./order-feed";

test("a failed post-fill sync reports the failure with a Brokers action and never resubmits the order", async () => {
  const demo = createDemoBroker({ seedOrders: false });
  const notifications: AppNotificationRequest[] = [];
  const panes: string[] = [];
  let syncs = 0;
  let runSync: (() => void) | undefined;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((run: () => void, delay: number) => {
    if (delay === 2_000) { runSync = run; return 0; }
    return realSetTimeout(run, delay);
  }) as typeof setTimeout;
  try {
    await brokerTradingModule.setup!({
      getConfig: () => ({ brokerInstances: [] }),
      on: () => () => {},
      notify: (notice: AppNotificationRequest) => notifications.push(notice),
      showPane: (pane: string) => panes.push(pane),
      syncBrokerInstance: async () => { syncs++; throw new Error("private account payload"); },
      registerTickerResearchTab() {}, registerCommand() {}, registerTickerAction() {},
    } as unknown as GloomPluginContext);
    brokerOrderFeed.note(demo.instance.id, {
      orderId: 7, brokerOrderId: "demo-7", accountId: demo.draft.accountId,
      status: "FILLED", quantity: 10, filled: 10, remaining: 0,
      action: "BUY", orderType: "MKT", contract: demo.draft.contract, updatedAt: Date.now(),
    });
    expect(runSync).toBeDefined();
    runSync!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(syncs).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ title: "Position sync failed", type: "error" });
    expect(notifications[0]!.body).not.toContain("private account");
    notifications[0]!.action!.onClick();
    expect(panes).toEqual(["brokers"]);
    expect(syncs).toBe(1);
  } finally {
    brokerTradingModule.dispose!();
    globalThis.setTimeout = realSetTimeout;
  }
});
