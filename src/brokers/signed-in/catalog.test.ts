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
