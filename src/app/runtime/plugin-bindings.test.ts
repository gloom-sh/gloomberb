import { afterEach, expect, test } from "bun:test";
import { setConfigStoreHost, type ConfigStoreHost } from "../../data/config/store";
import type { MarketDataCoordinator } from "../../market-data/coordinator";
import type { PluginRegistry } from "../../plugins/registry";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../state/app/context";
import { createTestBrokerAdapter } from "../../test-support/broker";
import { createDefaultConfig, type AppConfig, type BrokerInstanceConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import { bindPluginRegistryRuntimeAccess } from "./plugin-bindings";

afterEach(() => {
  setConfigStoreHost(null);
});

// On the desktop an adapter's disconnect is a call to the Bun process, which
// throws before returning a promise when that host is missing; the `.catch`
// on its result never saw it, and the profile stayed.
test("a profile goes even when its adapter's disconnect throws", async () => {
  const saved: AppConfig[] = [];
  setConfigStoreHost({ saveConfig: async (config: AppConfig) => { saved.push(config); } } as unknown as ConfigStoreHost);
  const instance: BrokerInstanceConfig = { id: "demo-live", brokerType: "demo", label: "Demo", config: {} };
  const stateRef: { current: AppState } = {
    current: createInitialState({ ...createDefaultConfig("/tmp/gloomberb-remove-broker-test"), brokerInstances: [instance] }),
  };
  const pluginRegistry = {
    brokers: new Map([["demo", createTestBrokerAdapter({
      disconnect: () => { throw new Error("Broker remote host is not available."); },
    })]]),
    persistence: { resources: { list: () => [], delete: () => {} } },
    events: { emit() {} },
  } as unknown as PluginRegistry;
  bindPluginRegistryRuntimeAccess({
    dataProvider: {} as DataProvider,
    dispatch: (action: AppAction) => { stateRef.current = appReducer(stateRef.current, action); },
    importBrokerPositions: async () => {},
    marketData: {} as MarketDataCoordinator,
    pluginRegistry,
    stateRef,
    tickerRepository: {} as never,
  });

  await pluginRegistry.removeBrokerInstanceFn("demo-live");

  expect(stateRef.current.config.brokerInstances).toEqual([]);
  expect(saved.at(-1)?.brokerInstances).toEqual([]);
});
