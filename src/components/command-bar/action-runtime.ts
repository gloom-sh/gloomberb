import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction, AppState } from "../../state/app/context";
import type { DataProvider } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import type { ThemePickerHandle } from "./theme-picker";
import { useCommandBarTickerSearchActions } from "./routes/ticker-search/actions";
import { useCommandBarPluginCommandActions } from "./commands/plugin/actions";
import { useCommandBarPaneTemplateActions } from "./pane-templates/workflow";
import { useCommandBarDirectCommandRuntime } from "./commands/direct/runtime";
import { useCommandBarConfirmRoute } from "./routing/confirm";
import { useCommandBarPaneActions } from "./pane-actions";
import { useCommandBarWorkflowCoordinator } from "./workflow/coordinator";
import { useCommandBarRouteActions } from "./routing/actions";
import { useCommandBarLaunchRequest } from "./routing/launch-request";
import type { CommandBarRoute } from "./workflow/types";

interface UseCommandBarActionRuntimeOptions {
  activeCollectionId: string | null;
  activeFinancials: TickerFinancials | null;
  activeTickerData: TickerRecord | null;
  activeTickerSymbol: string | null;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  config: AppState["config"];
  currentRoute: CommandBarRoute | null;
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  focusedPaneId: string | null;
  onCheckForUpdates?: () => void | Promise<void>;
  persistConfig: (nextConfig: AppState["config"]) => void;
  pluginRegistry: PluginRegistry;
  pushRoute: (route: CommandBarRoute) => void;
  quitApp: () => void;
  rootThemeBaseIdRef: MutableRefObject<string | null>;
  setRootQuery: (query: string) => void;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  skipTickerSearchDebounceRef: MutableRefObject<boolean>;
  state: AppState;
  stateRef: MutableRefObject<AppState>;
  themePickerRef: MutableRefObject<ThemePickerHandle | null>;
  tickerRepository: AppTickerRepositoryPort;
  tickers: AppState["tickers"];
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
}

export function useCommandBarActionRuntime({
  activeCollectionId,
  activeFinancials,
  activeTickerData,
  activeTickerSymbol,
  closeAll,
  config,
  currentRoute,
  dataProvider,
  dispatch,
  focusedPaneId,
  onCheckForUpdates,
  persistConfig,
  pluginRegistry,
  pushRoute,
  quitApp,
  rootThemeBaseIdRef,
  setRootQuery,
  setRouteStack,
  skipTickerSearchDebounceRef,
  state,
  stateRef,
  themePickerRef,
  tickerRepository,
  tickers,
  updateTopRoute,
}: UseCommandBarActionRuntimeOptions) {
  const {
    duplicatePane,
    focusTicker,
    notifyGridlockRevert,
    persistLayoutChange,
    setActiveCollection,
  } = useCommandBarPaneActions({
    dispatch,
    pluginRegistry,
    stateRef,
  });

  const {
    buildTickerSearchResultItems,
    localTickerSearchResultItems,
    mapTickerSearchCandidateToResultItem,
    readTickerSearchCache,
    writeTickerSearchCache,
  } = useCommandBarTickerSearchActions({
    closeAll,
    dispatch,
    focusTicker,
    pluginRegistry,
    tickerRepository,
    tickers,
  });

  const openModeRoute = useCallback((
    screen: "ticker-search" | "layout",
    initialQuery = "",
    payload?: Record<string, unknown>,
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
    });
  }, [pushRoute, skipTickerSearchDebounceRef]);

  const notify = useCallback((body: string, options?: { type?: "info" | "success" | "error" }) => {
    pluginRegistry.notify({ body, ...options });
  }, [pluginRegistry]);

  const {
    buildSharedWorkflowDeps,
    collectionWorkflowActions,
    ensureRouteFieldFocus,
    focusWorkflowField,
    getWorkflowFieldStringValue,
    getWorkflowInputRef,
    moveWorkflowFocus,
    openWorkflowFieldPicker,
    openWorkflowRoute,
    setWorkflowNativeSelectRef,
    submitWorkflowRoute,
    syncActiveWorkflowTextarea,
    updateWorkflowValue,
    workflowNativeSelectRefs,
    workflowScrollRef,
    openAddToPortfolioWorkflow,
    openBuiltInWorkflow,
  } = useCommandBarWorkflowCoordinator({
    activeCollectionId,
    activeLayoutIndex: config.activeLayoutIndex,
    activeTicker: activeTickerData,
    activeTickerSymbol,
    closeAll,
    currentRoute,
    dataProvider,
    dispatch,
    notify,
    persistConfig,
    pluginRegistry,
    pushRoute,
    setActiveCollection,
    setRouteStack,
    stateRef,
    tickerRepository,
    updateTopRoute,
  });

  const {
    confirmCurrentRoute,
    openInlineConfirm,
  } = useCommandBarConfirmRoute({
    closeAll,
    currentRoute,
    pushRoute,
    setRouteStack,
    updateTopRoute,
  });

  const {
    buildLayoutItems,
    buildPaneSettingItems,
    buildWindowModeItems,
    executeCollectionCommand,
    openPaneSettingsRoute,
    tickerActionItems,
  } = useCommandBarRouteActions({
    activeCollectionId,
    activeFinancials,
    activeTickerData,
    activeTickerSymbol,
    buildSharedWorkflowDeps,
    closeAll,
    dispatch,
    duplicatePane,
    notify,
    notifyGridlockRevert,
    openAddToPortfolioWorkflow,
    openBuiltInWorkflow,
    openInlineConfirm,
    openModeRoute,
    openWorkflowRoute,
    persistConfig,
    persistLayoutChange,
    pluginRegistry,
    pushRoute,
    state,
    stateRef,
    updateTopRoute,
  });

  const {
    createPluginCommandItem,
    getAvailablePluginCommands,
    openPluginCommandWorkflow,
    pluginCommandItems,
    pluginCommandResultItems,
  } = useCommandBarPluginCommandActions({
    activeCollectionId,
    activeTickerSymbol,
    closeAll,
    config,
    notify,
    openInlineConfirm,
    openWorkflowRoute,
    pluginRegistry,
  });

  useCommandBarLaunchRequest({
    activeTickerSymbol,
    commandBarLaunchRequest: state.commandBarLaunchRequest,
    commandBarOpen: state.commandBarOpen,
    openModeRoute,
    openPluginCommandWorkflow,
    pluginRegistry,
  });

  const {
    adaptTickerSearchRouteResult,
    createPaneTemplateItem,
    getAvailablePaneShortcutTemplates,
    getAvailablePaneTemplates,
    nonShortcutPaneTemplateItems,
    openPaneTemplateWorkflow,
    paneShortcutItems,
  } = useCommandBarPaneTemplateActions({
    activeCollectionId,
    activeTickerSymbol,
    buildWorkflowDeps: buildSharedWorkflowDeps,
    closeAll,
    config,
    executeCollectionCommand,
    focusedPaneId,
    notify,
    openModeRoute,
    openWorkflowRoute,
    pluginRegistry,
  });

  const {
    runDirectCommand,
    runSecurityDescriptionShortcut,
  } = useCommandBarDirectCommandRuntime({
    activeCollectionId,
    activeTickerSymbol,
    buildSharedWorkflowDeps,
    closeAll,
    dispatch,
    executeCollectionCommand,
    focusTicker,
    notify,
    onCheckForUpdates,
    openBuiltInWorkflow,
    openInlineConfirm,
    openModeRoute,
    openPaneSettingsRoute,
    persistConfig,
    pluginRegistry,
    pushRoute,
    quitApp,
    rootThemeBaseIdRef,
    setRootQuery,
    stateRef,
    themePickerRef,
  });

  return {
    adaptTickerSearchRouteResult,
    buildLayoutItems,
    buildPaneSettingItems,
    buildTickerSearchResultItems,
    buildWindowModeItems,
    collectionWorkflowActions,
    confirmCurrentRoute,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePaneTemplates,
    getAvailablePluginCommands,
    getWorkflowFieldStringValue,
    getWorkflowInputRef,
    ensureRouteFieldFocus,
    focusWorkflowField,
    localTickerSearchResultItems,
    mapTickerSearchCandidateToResultItem,
    moveWorkflowFocus,
    nonShortcutPaneTemplateItems,
    openInlineConfirm,
    openModeRoute,
    openPaneTemplateWorkflow,
    openPluginCommandWorkflow,
    openWorkflowFieldPicker,
    paneShortcutItems,
    persistLayoutChange,
    pluginCommandItems,
    pluginCommandResultItems,
    readTickerSearchCache,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setWorkflowNativeSelectRef,
    submitWorkflowRoute,
    syncActiveWorkflowTextarea,
    tickerActionItems,
    updateWorkflowValue,
    workflowNativeSelectRefs,
    workflowScrollRef,
    writeTickerSearchCache,
  };
}
