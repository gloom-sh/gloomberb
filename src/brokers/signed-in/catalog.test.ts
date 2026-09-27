import { expect, test } from "bun:test";
import type { PluginPersistence } from "../../types/plugin";
import { createSignedInBrokerCatalog } from "./catalog";
import type { SignedInBroker } from "./client";

const IBKR: SignedInBroker = {
  id: "ibkr",
  name: "Interactive Brokers",
  capabilities: { history: true, executions: true, orders: false, singleConnection: true },
};

function memoryPersistence(): PluginPersistence {
  const state = new Map<string, unknown>();
  return {
    getState: <T,>(key: string) => (state.get(key) as T | undefined) ?? null,
    setState: (key, value) => { state.set(key, value); },
    deleteState: (key) => { state.delete(key); },
    getResource: () => null,
    setResource: () => { throw new Error("unused"); },
    deleteResource: () => {},
  };
}

test("one fetch at a time, the last list survives a failure and a restart, and a fresh list is not refetched", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const load = async () => {
    calls += 1;
    await Promise.resolve();
    if (fail) throw new Error("offline");
    return { connectors: [IBKR] };
  };
  const persistence = memoryPersistence();
  const catalog = createSignedInBrokerCatalog(load, () => now);
  catalog.attach(persistence);

  await Promise.all([catalog.refresh(), catalog.refresh()]);
  expect(calls).toBe(1);
  expect(catalog.get()).toEqual([IBKR]);

  now += 60_000;
  await catalog.refresh();
  expect(calls).toBe(1);

  now += 5 * 60_000;
  fail = true;
  await catalog.refresh();
  expect(calls).toBe(2);
  expect(catalog.get()).toEqual([IBKR]);

  const restarted = createSignedInBrokerCatalog(async () => { throw new Error("offline"); });
  restarted.attach(persistence);
  expect(restarted.find("ibkr")).toEqual(IBKR);
});

test("a process that never fetches picks up a newer list another one saved, looking once a minute", async () => {
  let now = 1_000;
  const persistence = memoryPersistence();
  const trading: SignedInBroker = { ...IBKR, capabilities: { ...IBKR.capabilities, orders: { mode: "review", types: ["LMT"] } } };
  let served = [IBKR];
  const view = createSignedInBrokerCatalog(async () => ({ connectors: served }), () => now);
  view.attach(persistence);
  await view.refresh();

  let bunLoads = 0;
  const bun = createSignedInBrokerCatalog(async () => {
    bunLoads += 1;
    return { connectors: [] };
  }, () => now);
  bun.attach(persistence);
  expect(bun.find("ibkr")).toEqual(IBKR);

  now += 10 * 60_000;
  served = [trading];
  await view.refresh();
  expect(bun.find("ibkr")).toEqual(trading);

  // Within the minute the known list is kept without reading the store again.
  served = [IBKR];
  now += 30_000;
  await view.refresh({ force: true });
  expect(bun.find("ibkr")).toEqual(trading);
  now += 30_000;
  expect(bun.find("ibkr")).toEqual(IBKR);
  expect(bunLoads).toBe(0);
});
