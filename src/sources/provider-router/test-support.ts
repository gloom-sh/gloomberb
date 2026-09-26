import type { PluginRegistry } from "../../plugins/registry";
import type { BrokerAdapter } from "../../types/broker";
import { cloneLayout, createDefaultConfig, DEFAULT_LAYOUT, type AppConfig } from "../../types/config";
import type { AssetDataRouter } from "./index";

type BrokerInstance = AppConfig["brokerInstances"][number];

export function brokerInstance(overrides: Partial<BrokerInstance> = {}): BrokerInstance {
  return {
    id: "ibkr-work",
    brokerType: "ibkr",
    label: "Work",
    connectionMode: "gateway",
    config: {},
    enabled: true,
    ...overrides,
  };
}

export function createBrokerConfig(brokerInstances: BrokerInstance[]): AppConfig {
  const layout = cloneLayout(DEFAULT_LAYOUT);
  return {
    ...createDefaultConfig(""),
    portfolios: [],
    watchlists: [],
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
    brokerInstances,
  };
}

export function attachTestRegistry(
  router: AssetDataRouter,
  options: {
    brokers?: Array<[string, BrokerAdapter]>;
    getEnabledCapabilities?: PluginRegistry["getEnabledCapabilities"];
  } = {},
): void {
  router.attachRegistry({
    brokers: new Map(options.brokers ?? []),
    getEnabledCapabilities: options.getEnabledCapabilities ?? (() => []),
  } as unknown as PluginRegistry);
}

export function setBrokerInstances(router: AssetDataRouter, brokerInstances: BrokerInstance[]): void {
  router.setConfigAccessor(() => createBrokerConfig(brokerInstances));
}
