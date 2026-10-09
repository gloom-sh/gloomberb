import { expect, test } from "bun:test";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createDefaultConfig } from "../../../types/config";
import { brokerOrdersHeadless } from "./headless";
import { loadBrokerOrdersSnapshot } from "./orders-data";
import { createDemoBroker, DEMO_LIVE_ACCOUNT, DEMO_SIM_ACCOUNT } from "./test-fixture";

function contextFor(demo: ReturnType<typeof createDemoBroker>) {
  const config = createDefaultConfig("/synthetic/orders-report");
  config.brokerInstances = [demo.instance];
  return createTestHeadlessContext({ config, resolveBroker: (type) => type === demo.adapter.id ? demo.adapter : null });
}

test("headless requires account selection and only reads the selected account without exposing config or identifiers", async () => {
  const demo = createDemoBroker({ mode: "both" });
  demo.instance.config.clientSecret = "synthetic-secret-never-in-report";
  const live = demo.order({ ...demo.draft, accountId: DEMO_LIVE_ACCOUNT, contract: { ...demo.draft.contract, symbol: "OTHER" } });
  demo.seedOrder(live);
  const context = contextFor(demo);
  await expect(brokerOrdersHeadless.load(createTestHeadlessArgs(), context)).rejects.toThrow("Choose an account");
  const result = await brokerOrdersHeadless.load(createTestHeadlessArgs({ options: { account: 1 } }), context);
  const json = JSON.stringify(result);
  expect(json).toContain("SIMULATION");
  expect(json).not.toContain("OTHER");
  expect(json).not.toContain(DEMO_SIM_ACCOUNT);
  expect(json).not.toContain(DEMO_LIVE_ACCOUNT);
  expect(json).not.toContain("synthetic-secret-never-in-report");
  expect(demo.calls.every((call) => ["listAccounts", "listOpenOrders", "listExecutions"].includes(call.method))).toBe(true);
});

test("account projection excludes unattributed and foreign-profile rows and preserves partial failures", async () => {
  const demo = createDemoBroker();
  demo.seedOrder({ ...demo.order(demo.draft), accountId: undefined });
  demo.seedOrder({ ...demo.order(demo.draft), brokerInstanceId: "foreign-profile" });
  demo.adapter.listExecutions = async () => { throw new Error("upstream-private-payload"); };
  const snapshot = await loadBrokerOrdersSnapshot(demo.adapter, demo.instance, DEMO_SIM_ACCOUNT);
  expect(snapshot.orders).toHaveLength(2);
  expect(snapshot.executions).toEqual([]);
  expect(snapshot.errors).toEqual(["Recent activity is unavailable. Refresh to try again."]);
  expect(snapshot.notes).toContain("Rows without an account identity are omitted.");
  expect(JSON.stringify(snapshot)).not.toContain("upstream-private-payload");
});

test("headless labels cumulative summaries and honors abort before any broker read", async () => {
  const demo = createDemoBroker();
  const capabilities = demo.adapter.getTradingCapabilities!;
  demo.adapter.getTradingCapabilities = (...args) => ({ ...capabilities(...args), executionKind: "order-summaries" });
  const context = contextFor(demo);
  const result = await brokerOrdersHeadless.load(createTestHeadlessArgs({ options: { view: "activity" } }), context);
  expect(result.sections.map((section) => section.title)).toEqual(["Account", "Cumulative order summaries"]);
  const calls = demo.calls.length;
  const abort = new AbortController(); abort.abort();
  await expect(brokerOrdersHeadless.load(createTestHeadlessArgs(), { ...context, signal: abort.signal })).rejects.toThrow();
  expect(demo.calls).toHaveLength(calls);
});
