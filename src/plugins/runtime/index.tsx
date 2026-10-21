import { useCallback } from "react";
import type { CapabilityInvoker } from "../../capabilities";
import type { AppNotificationRequest } from "../../types/plugin";
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

/**
 * `notify` for what one pane says about itself: an action of its own that
 * finished or failed, its data, its broker profile. It shows in this pane's
 * footer, not in the app's toasts, which are for app-wide events. Outside a
 * pane it is the app's `notify`.
 */
export function usePaneNotify(): (notification: AppNotificationRequest) => void {
  const { runtime } = usePluginRenderContext();
  const paneId = useOptionalPaneInstanceId();
  return useCallback((notification: AppNotificationRequest) => {
    runtime.notify(paneId ? { ...notification, paneId } : notification);
  }, [paneId, runtime]);
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

const noBrokerLogo = (): string | null => null;

export function usePluginBrokerActions() {
  const { runtime } = usePluginRenderContext();
  return {
    getBrokerAdapter: runtime.getBrokerAdapter,
    listBrokerAdapters: runtime.listBrokerAdapters,
    getBrokerLogo: runtime.getBrokerLogo ?? noBrokerLogo,
    createBrokerInstance: runtime.createBrokerInstance,
    connectBrokerInstance: runtime.connectBrokerInstance,
    updateBrokerInstance: runtime.updateBrokerInstance,
    syncBrokerInstance: runtime.syncBrokerInstance,
    removeBrokerInstance: runtime.removeBrokerInstance,
  };
}
