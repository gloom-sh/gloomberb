import { useCallback } from "react";
import { useOptionalPaneInstanceId } from "../../state/app/context";
import type { AppNotificationRequest, PaneTemplateCreateOptions } from "../../types/plugin";
import {
  usePluginRenderContext,
  type PluginRuntimeAccess,
} from "./context";

export {
  PluginRenderProvider,
  wrapPaneDefWithRuntime,
  wrapTickerResearchTabDefWithRuntime,
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
  useSetPluginConfigStates,
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
  const selectTicker = useCallback((symbol: string, paneId?: string) => {
    runtime.selectTicker(symbol, paneId);
  }, [runtime]);
  const switchTab = useCallback((tabId: string, paneId?: string) => {
    runtime.switchTab(tabId, paneId);
  }, [runtime]);
  const switchPanel = useCallback((panel: "left" | "right") => {
    runtime.switchPanel(panel);
  }, [runtime]);

  return {
    selectTicker,
    switchTab,
    switchPanel,
  };
}

export function usePluginAppActions() {
  const { runtime } = usePluginRenderContext();
  const openCommandBar = useCallback((query?: string) => {
    runtime.openCommandBar(query);
  }, [runtime]);
  const showPane = useCallback((paneId: string) => {
    runtime.showPane(paneId);
  }, [runtime]);
  const createPaneFromTemplate = useCallback((templateId: string, options?: PaneTemplateCreateOptions) => {
    runtime.createPaneFromTemplate(templateId, options);
  }, [runtime]);
  const hidePane = useCallback((paneId: string) => {
    runtime.hidePane(paneId);
  }, [runtime]);
  const focusPane = useCallback((paneId: string) => {
    runtime.focusPane(paneId);
  }, [runtime]);
  const openPaneSettings = useCallback((paneId?: string) => {
    runtime.openPaneSettings(paneId);
  }, [runtime]);
  const openPluginCommandWorkflow = useCallback((commandId: string) => {
    runtime.openPluginCommandWorkflow(commandId);
  }, [runtime]);
  const notify = useCallback((notification: AppNotificationRequest) => {
    runtime.notify(notification);
  }, [runtime]);

  return {
    openCommandBar,
    showPane,
    createPaneFromTemplate,
    hidePane,
    focusPane,
    openPaneSettings,
    openPluginCommandWorkflow,
    notify,
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
