import { useCallback } from "react";
import { useOptionalPaneInstanceId } from "../../state/app/context";
import {
  usePluginRenderContext,
  type PluginRuntimeAccess,
} from "./context";

export {
  PluginRenderProvider,
  wrapPaneDefWithRuntime,
  wrapTickerResearchTabDefWithRuntime
} from "./context";
export type { PluginRuntimeAccess } from "./context";

export {
  deletePluginPaneStateValue,
  getPluginPaneStateValue,
  setPluginPaneStateValue,
  useDebouncedPluginPaneState,
  usePluginConfigState,
  usePluginPaneState,
  usePluginState,
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
    openPluginCommandWorkflow: runtime.openPluginCommandWorkflow,
    notify: runtime.notify,
  };
}

export function useMarketData(): ReturnType<PluginRuntimeAccess["getMarketData"]> {
  const { runtime } = usePluginRenderContext();
  return runtime.getMarketData();
}

export function useAssetData(): ReturnType<PluginRuntimeAccess["getMarketData"]> {
  return useMarketData();
}

export function useConnectionHealth(): ReturnType<PluginRuntimeAccess["getConnectionHealth"]> {
  const { runtime } = usePluginRenderContext();
  return runtime.getConnectionHealth();
}

export function useCapabilityInvoker(): PluginRuntimeAccess {
  return usePluginRenderContext().runtime;
}

export function usePluginBrokerActions() {
  const { runtime } = usePluginRenderContext();
  return {
    getBrokerAdapter: runtime.getBrokerAdapter,
    connectBrokerInstance: runtime.connectBrokerInstance,
    updateBrokerInstance: runtime.updateBrokerInstance,
    syncBrokerInstance: runtime.syncBrokerInstance,
    removeBrokerInstance: runtime.removeBrokerInstance,
  };
}
