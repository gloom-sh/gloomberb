import type { PluginRuntimeAccess } from "../plugins/runtime";
import { ConnectionHealthRegistry } from "../core/connection-health";
import type { AppConfig } from "../types/config";

interface TestConfigAccess {
  getConfig(): AppConfig | null | undefined;
  setConfig(config: AppConfig): void;
}

export function createTestPluginRuntime(
  overrides: Partial<PluginRuntimeAccess> = {},
): PluginRuntimeAccess {
  const connectionHealth = new ConnectionHealthRegistry();
  return {
    getMarketData: () => null,
    getConnectionHealth: () => connectionHealth,
    getCapability: () => null,
    getBrokerAdapter: () => null,
    connectBrokerInstance: async () => {},
    updateBrokerInstance: async () => {},
    syncBrokerInstance: async () => {},
    removeBrokerInstance: async () => {},
    pinTicker() {},
    navigateTicker() {},
    selectTicker() {},
    switchTab() {},
    switchPanel() {},
    openCommandBar() {},
    showPane() {},
    createPaneFromTemplate() {},
    hidePane() {},
    focusPane() {},
    openPaneSettings() {},
    openPluginCommandWorkflow() {},
    notify() {},
    subscribeResumeState: () => () => {},
    getResumeState: () => null,
    setResumeState() {},
    deleteResumeState() {},
    getConfigState: () => null,
    setConfigState: async () => {},
    setConfigStates: async () => {},
    deleteConfigState: async () => {},
    getConfigStateKeys: () => [],
    ...overrides,
  };
}

export function createStatefulTestPluginRuntime(
  overrides: Partial<PluginRuntimeAccess> = {},
): PluginRuntimeAccess {
  const resumeState = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const configState = new Map<string, Map<string, unknown>>();
  const resumeKey = (pluginId: string, key: string) => `${pluginId}:${key}`;
  const pluginConfig = (pluginId: string) => {
    let state = configState.get(pluginId);
    if (!state) {
      state = new Map();
      configState.set(pluginId, state);
    }
    return state;
  };
  const emitResumeChange = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };

  return createTestPluginRuntime({
    subscribeResumeState(pluginId, key, listener) {
      const storeKey = resumeKey(pluginId, key);
      if (!listeners.has(storeKey)) listeners.set(storeKey, new Set());
      listeners.get(storeKey)!.add(listener);
      return () => listeners.get(storeKey)?.delete(listener);
    },
    getResumeState(pluginId, key) {
      return (resumeState.get(resumeKey(pluginId, key)) as any) ?? null;
    },
    setResumeState(pluginId, key, value) {
      const storeKey = resumeKey(pluginId, key);
      resumeState.set(storeKey, value);
      emitResumeChange(storeKey);
    },
    deleteResumeState(pluginId, key) {
      const storeKey = resumeKey(pluginId, key);
      resumeState.delete(storeKey);
      emitResumeChange(storeKey);
    },
    getConfigState(pluginId, key) {
      return (pluginConfig(pluginId).get(key) as any) ?? null;
    },
    async setConfigState(pluginId, key, value) {
      pluginConfig(pluginId).set(key, value);
    },
    async setConfigStates(pluginId, values) {
      const state = pluginConfig(pluginId);
      for (const [key, value] of Object.entries(values)) state.set(key, value);
    },
    async deleteConfigState(pluginId, key) {
      pluginConfig(pluginId).delete(key);
    },
    getConfigStateKeys(pluginId) {
      return [...pluginConfig(pluginId).keys()].sort();
    },
    ...overrides,
  });
}

export function createConfigBackedTestPluginRuntime(
  access: TestConfigAccess,
  overrides: Partial<PluginRuntimeAccess> = {},
): PluginRuntimeAccess {
  const requireConfig = () => {
    const config = access.getConfig();
    if (!config) throw new Error("test plugin runtime used before config is available");
    return config;
  };
  const writePluginConfig = (pluginId: string, values: Record<string, unknown>) => {
    const config = requireConfig();
    access.setConfig({
      ...config,
      pluginConfig: {
        ...config.pluginConfig,
        [pluginId]: {
          ...(config.pluginConfig[pluginId] ?? {}),
          ...values,
        },
      },
    });
  };

  return createStatefulTestPluginRuntime({
    getConfigState(pluginId, key) {
      return (access.getConfig()?.pluginConfig[pluginId]?.[key] as any) ?? null;
    },
    async setConfigState(pluginId, key, value) {
      writePluginConfig(pluginId, { [key]: value });
    },
    async setConfigStates(pluginId, values) {
      writePluginConfig(pluginId, values);
    },
    async deleteConfigState(pluginId, key) {
      const config = requireConfig();
      const currentPluginConfig = { ...(config.pluginConfig[pluginId] ?? {}) };
      delete currentPluginConfig[key];
      const pluginConfig = { ...config.pluginConfig };
      if (Object.keys(currentPluginConfig).length === 0) delete pluginConfig[pluginId];
      else pluginConfig[pluginId] = currentPluginConfig;
      access.setConfig({ ...config, pluginConfig });
    },
    getConfigStateKeys(pluginId) {
      return Object.keys(access.getConfig()?.pluginConfig[pluginId] ?? {}).sort();
    },
    ...overrides,
  });
}
