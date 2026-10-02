import { useCallback } from "react";
import type { CapabilityInvoker } from "../../capabilities";
import { useOptionalPaneInstanceId } from "../../state/app/context";
import {
  usePluginRenderContext,
  type PluginRuntimeAccess,
} from "./context";

export { PluginRenderProvider, withPluginRender } from "./context";
export type { PluginRuntimeAccess } from "./context";

export {
  deletePluginPaneStateValue,
  getPluginPaneStateValue,
  setPluginPaneStateValue,
  useDebouncedPluginPaneState,
  usePluginConfigState,
  usePluginPaneState,
  usePluginState,
  usePrunePluginPaneState,
  useSetPluginConfigStates
} from "./state";

export function usePluginTickerActions() {
  const { runtime } = usePluginRenderContext();
  const sourcePaneId = useOptionalPaneInstanceId();
  const navigateTicker = useCallback((symbol: string) => {
    runtime.navigateTicker(symbol, { sourcePaneId });
  }, [runtime, sourcePaneId]);
  return {
    pinTicker: runtime.pinTicker,
    navigateTicker,
  };
}

export function usePluginPaneActions() {
  const { runtime } = usePluginRenderContext();
  return {
    selectTicker: runtime.selectTicker,
    switchTab: runtime.switchTab,
    switchPanel: runtime.switchPanel,
  };
}

export function usePluginAppActions() {
  const { runtime } = usePluginRenderContext();
  return {
    openCommandBar: runtime.openCommandBar,
    showPane: runtime.showPane,
    createPaneFromTemplate: runtime.createPaneFromTemplate,
    hidePane: runtime.hidePane,
    focusPane: runtime.focusPane,
    openPaneSettings: runtime.openPaneSettings,
    sharePane: runtime.sharePane,
    openPluginCommandWorkflow: runtime.openPluginCommandWorkflow,
    notify: runtime.notify,
  };
}

/** The active asset-data client, or null before the app has one. */
export function useAssetData(): ReturnType<PluginRuntimeAccess["getMarketData"]> {
  const { runtime } = usePluginRenderContext();
  return runtime.getMarketData();
}

/** @deprecated Use `useAssetData`, which returns the same client. */
export function useMarketData(): ReturnType<PluginRuntimeAccess["getMarketData"]> {
  return useAssetData();
}

export function useConnectionHealth(): ReturnType<PluginRuntimeAccess["getConnectionHealth"]> {
  const { runtime } = usePluginRenderContext();
  return runtime.getConnectionHealth();
}

/** Request/response access to capabilities registered by any plugin. */
export function useCapabilityInvoker(): CapabilityInvoker {
  return usePluginRenderContext().runtime;
}

export function usePluginBrokerActions() {
  const { runtime } = usePluginRenderContext();
  return {
    getBrokerAdapter: runtime.getBrokerAdapter,
    listBrokerAdapters: runtime.listBrokerAdapters,
    createBrokerInstance: runtime.createBrokerInstance,
    connectBrokerInstance: runtime.connectBrokerInstance,
    updateBrokerInstance: runtime.updateBrokerInstance,
    syncBrokerInstance: runtime.syncBrokerInstance,
    removeBrokerInstance: runtime.removeBrokerInstance,
  };
}
