import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import type { BrokerAdapter, BrokerConnectionStatus } from "../../../../types/broker";
import type { BrokerInstanceConfig } from "../../../../types/config";
import { resolveOfflineBroker, useLiveBrokerAccounts, type LiveBrokerAccounts } from "./live-accounts";

const tui = createOpenTuiTestHarness();
let latest: LiveBrokerAccounts | null = null;
let setRefreshKey: ((key: number) => void) | null = null;

afterEach(() => {
  latest = null;
  setRefreshKey = null;
});

const instance: BrokerInstanceConfig = { id: "rh", brokerType: "robinhood", label: "Robinhood", config: {}, enabled: true };

function Harness({ broker }: { broker: BrokerAdapter }) {
  const [refreshKey, setKey] = useState(0);
  setRefreshKey = setKey;
  latest = useLiveBrokerAccounts(broker, instance, refreshKey);
  return <text>{latest.accounts.length}</text>;
}

test("reloads accounts on connection changes and explicit refreshes, not on status rewrites", async () => {
  let status: BrokerConnectionStatus = { state: "disconnected", updatedAt: 0 };
  const listeners = new Set<() => void>();
  let loads = 0;
  const broker: BrokerAdapter = {
    id: "robinhood",
    name: "Robinhood",
    configSchema: [],
    validate: async () => true,
    importPositions: async () => [],
    getStatus: () => status,
    subscribeStatus(_instance, listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async listAccounts() {
      loads += 1;
      // Loading rewrites the status, as the Robinhood adapter does. Capped so
      // a regression fails the counts below instead of hanging.
      if (loads < 10) setStatus({ state: "connected", message: "Connected" });
      return [{ accountId: "A1", name: "A1" }];
    },
  };
  const setStatus = (next: Omit<BrokerConnectionStatus, "updatedAt">) => {
    status = { ...next, updatedAt: status.updatedAt + 1 };
    for (const listener of listeners) listener();
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  };

  await tui.render(<Harness broker={broker} />, { width: 10, height: 1 });
  await settle();
  expect(loads).toBe(0);

  await act(async () => setStatus({ state: "connected", message: "Connected" }));
  await settle();
  await settle();
  expect(loads).toBe(1);
  expect(latest?.accounts.map((account) => account.accountId)).toEqual(["A1"]);

  await act(async () => setStatus({ state: "connected", message: "Connected" }));
  await settle();
  expect(loads).toBe(1);

  await act(async () => setRefreshKey?.(1));
  await settle();
  expect(loads).toBe(2);

  await act(async () => setStatus({ state: "disconnected" }));
  await settle();
  expect(latest?.accounts).toEqual([]);
  await act(async () => setStatus({ state: "connected", message: "Connected" }));
  await settle();
  expect(loads).toBe(3);
});

test("only a broker that could be connected and is not, or is turned off, counts as offline", () => {
  const portfolio = { id: "broker:rh:A1", name: "A1", currency: "USD", brokerInstanceId: "rh", lastSyncedAt: 5 };
  const broker: BrokerAdapter = { id: "robinhood", name: "Robinhood", configSchema: [], validate: async () => true, importPositions: async () => [] };
  const status = (state: BrokerConnectionStatus["state"], extra: Partial<BrokerConnectionStatus> = {}): BrokerConnectionStatus => ({ state, updatedAt: 0, ...extra });

  expect(resolveOfflineBroker(portfolio, instance, broker, status("disconnected"))).toMatchObject({ syncedAt: 5, reason: "Robinhood disconnected", reconnectable: true });
  expect(resolveOfflineBroker(portfolio, instance, broker, status("error", { message: "Sign in again." }))?.reason).toBe("Sign in again.");
  // No plugin connects it: still dated, but no key could bring it back.
  expect(resolveOfflineBroker(portfolio, { ...instance, brokerType: "ibkr" }, null, null)).toMatchObject({ reason: "IBKR unavailable", reconnectable: false });
  for (const quiet of [status("connected"), status("connecting"), status("disconnected", { mode: "flex" }), null]) {
    expect(resolveOfflineBroker(portfolio, instance, broker, quiet)).toBeNull();
  }
  // Turned off: dated, said so, and never reconnected; enabling it can sync it only when a plugin connects it.
  expect(resolveOfflineBroker(portfolio, { ...instance, enabled: false }, broker, status("connected")))
    .toMatchObject({ syncedAt: 5, reason: "Robinhood disabled", disabled: true, reconnectable: true });
  expect(resolveOfflineBroker(portfolio, { ...instance, brokerType: "ibkr", enabled: false }, null, null))
    .toMatchObject({ reason: "IBKR disabled", disabled: true, reconnectable: false });
});
