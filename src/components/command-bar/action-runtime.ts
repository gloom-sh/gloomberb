import { useCallback, type MutableRefObject } from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import type { DataProvider } from "../../types/data-provider";
import type { CommandBarEnvironment } from "./surface/environment";
import type { CommandBarNavigationState } from "./routing/navigation-state";
import { useCommandBarTickerSearchActions } from "./routes/ticker-search/actions";
import { useCommandBarPluginCommandActions } from "./commands/plugin/actions";
import { useCommandBarPaneTemplateActions } from "./pane-templates/workflow";
import { useCommandBarDirectCommandRuntime } from "./commands/direct/runtime";
import { useCommandBarInlineConfirm } from "./routing/confirm";
import { useCommandBarPaneActions } from "./pane-actions";
import { useCommandBarWorkflowCoordinator } from "./workflow/coordinator";
import { useCommandBarRouteActions } from "./routing/actions";
import { useCommandBarLaunchRequest } from "./routing/launch-request";

interface UseCommandBarActionRuntimeOptions {
  env: CommandBarEnvironment;
  nav: CommandBarNavigationState;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  dataProvider: DataProvider;
  onCheckForUpdates?: () => void | Promise<void>;
  /** Settings' Run Setup Again; absent where setup cannot run. */
  onRunSetupAgain?: () => Promise<void>;
  pluginRegistry: PluginRegistry;
  quitApp: () => void;
  rootThemeBaseIdRef: MutableRefObject<string | null>;
  tickerRepository: AppTickerRepositoryPort;
}

export function useCommandBarActionRuntime({
  env,
  nav,
  closeAll,
  dataProvider,
  onCheckForUpdates,
  onRunSetupAgain,
  pluginRegistry,
  quitApp,
  rootThemeBaseIdRef,
  tickerRepository,
}: UseCommandBarActionRuntimeOptions) {
  const { dispatch, skipTickerSearchDebounceRef, state, stateRef } = env;
  const { pushRoute, setRootQuery } = nav;

  const { changePaneTicker, duplicatePane, focusTicker, persistLayoutChange } = useCommandBarPaneActions({
    dispatch,
    pluginRegistry,
    stateRef,
  });

  const tickerSearchActions = useCommandBarTickerSearchActions({
    changePaneTicker,
    closeAll,
    dispatch,
    focusTicker,
    pluginRegistry,
    tickerRepository,
    tickers: state.tickers,
  });

  const openModeRoute = useCallback((
    screen: "ticker-search" | "layout",
    initialQuery = "",
    payload?: Record<string, unknown>,
    options?: { launched?: boolean },
  ) => {
    if (screen === "ticker-search" && initialQuery.trim()) {
      skipTickerSearchDebounceRef.current = true;
    }
    pushRoute({
      kind: "mode",
      screen,
      query: initialQuery,
      selectedIdx: 0,
      hoveredIdx: null,
      payload,
      ...(options?.launched ? { launched: true } : {}),
    });
  }, [pushRoute, skipTickerSearchDebounceRef]);

  const notify = useCallback((body: string, options?: { type?: "info" | "success" | "error"; duration?: number }) => {
    pluginRegistry.notify({ body, ...options });
  }, [pluginRegistry]);

  const {
    buildSharedWorkflowDeps,
    collectionWorkflowActions,
    openAddToPortfolioWorkflow,
    openBuiltInWorkflow,
    openForm,
  } = useCommandBarWorkflowCoordinator({
    closeAll,
    dataProvider,
    dispatch,
    notify,
    pluginRegistry,
    tickerRepository,
  });

  const openInlineConfirm = useCommandBarInlineConfirm({ closeAll });

  const routeActions = useCommandBarRouteActions({
    env,
    buildSharedWorkflowDeps,
    closeAll,
    duplicatePane,
    notify,
    openAddToPortfolioWorkflow,
    openBuiltInWorkflow,
    openInlineConfirm,
    openModeRoute,
    persistLayoutChange,
    pluginRegistry,
    pushRoute,
  });

  const pluginCommandActions = useCommandBarPluginCommandActions({
    env,
    closeAll,
    notify,
    openForm,
    openInlineConfirm,
    pluginRegistry,
  });

  useCommandBarLaunchRequest({
    commandBarLaunchRequest: state.commandBarLaunchRequest,
    commandBarOpen: state.commandBarOpen,
    openModeRoute,
  });

  const paneTemplateActions = useCommandBarPaneTemplateActions({
    env,
    buildWorkflowDeps: buildSharedWorkflowDeps,
    closeAll,
    executeCollectionCommand: routeActions.executeCollectionCommand,
    notify,
    openForm,
    openModeRoute,
    pluginRegistry,
  });

  const directCommandRuntime = useCommandBarDirectCommandRuntime({
    env,
    buildSharedWorkflowDeps,
    closeAll,
    executeCollectionCommand: routeActions.executeCollectionCommand,
    focusTicker,
    notify,
    onCheckForUpdates,
    onRunSetupAgain,
    openBuiltInWorkflow,
    openInlineConfirm,
    openModeRoute,
    openPaneSettings: routeActions.openPaneSettings,
    pluginRegistry,
    pushRoute,
    quitApp,
    rootThemeBaseIdRef,
    setRootQuery,
  });

  return {
    ...tickerSearchActions,
    ...routeActions,
    ...pluginCommandActions,
    ...paneTemplateActions,
    ...directCommandRuntime,
    collectionWorkflowActions,
    openInlineConfirm,
    openModeRoute,
    persistLayoutChange,
  };
}

export type CommandBarActionRuntime = ReturnType<typeof useCommandBarActionRuntime>;
