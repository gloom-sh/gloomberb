import { useCallback, useMemo, useRef } from "react";
import type { DataProvider } from "../../../types/data-provider";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import type { LayoutBounds } from "../../../plugins/pane-manager";
import { usePlanAccess } from "../../../plugins/builtin/shared/plan-access";
import { buildAssistCommandInventory } from "../assist/inventory";
import { useCommandBarAssist } from "../assist/runtime";
import { shouldAutoAskAssist, type AssistRowHandlers } from "../assist/model";
import { useRouteListState } from "../routing/list-state";
import { useCommandBarRootRuntime } from "../routes/root/runtime";
import { parseRootShortcutIntent } from "../routes/root/shortcuts";
import { useCommandBarThemePreview } from "../theme-preview";
import { CommandBarPanel } from "../panel";
import { useCommandBarNavigationState } from "../routing/navigation-state";
import { useCommandBarSelectionRuntime } from "../selection-runtime";
import { useCommandBarPanelRuntime } from "../panel/runtime";
import { useCommandBarRouteEffects } from "../routing/effects";
import { useCommandBarEnvironment } from "./environment";
import { useCommandBarActionRuntime } from "../action-runtime";

interface CommandBarProps {
  dataProvider: DataProvider;
  tickerRepository: AppTickerRepositoryPort;
  pluginRegistry: PluginRegistry;
  quitApp: () => void;
  onCheckForUpdates?: () => void | Promise<void>;
  onNativeOccluderChange?: (rect: LayoutBounds | null) => void;
}

export function CommandBar({
  dataProvider,
  tickerRepository,
  pluginRegistry,
  quitApp,
  onCheckForUpdates,
  onNativeOccluderChange,
}: CommandBarProps) {
  const {
    activeCollectionId,
    activeFinancials,
    activePortfolio,
    activeTickerData,
    activeTickerSymbol,
    availableCommands,
    cellHeightPx,
    cellWidthPx,
    dispatch,
    getCommittedThemeId,
    nativeListScrollRef,
    nativePaneChrome,
    persistConfig,
    skipTickerSearchDebounceRef,
    state,
    stateRef,
    termHeight,
    termWidth,
    themePickerRef,
    titleBarOverlay,
    visibleListStateRef,
  } = useCommandBarEnvironment();
  const {
    applyThemePreview,
    clearThemePreview,
    commitTheme,
    restoreThemePreview,
    rootThemeBaseIdRef,
  } = useCommandBarThemePreview({
    dispatch,
    getCommittedThemeId,
    themePickerRef,
  });
  const {
    closeAll,
    currentRoute,
    currentRouteRef,
    dismissCommandBar,
    lastMainBrowseRef,
    popRoute,
    pushRoute,
    rootHoveredIdx,
    rootModeInfo,
    rootModeKindRef,
    rootQuery,
    rootQueryRef,
    rootSelectedIdx,
    setRootHoveredIdx,
    setRootQuery,
    setRootSelectedIdx,
    setRouteStack,
    updateTopRoute,
  } = useCommandBarNavigationState({
    availableCommands,
    dispatch,
    initialQuery: state.commandBarQuery,
    restoreThemePreview,
  });

  const {
    adaptTickerSearchRouteResult,
    buildLayoutItems,
    buildPaneSettingItems,
    buildPluginItems,
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
    ensureRouteFieldFocus,
    focusWorkflowField,
    getWorkflowFieldStringValue,
    getWorkflowInputRef,
    localTickerSearchResultItems,
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
  } = useCommandBarActionRuntime({
    activeCollectionId,
    activeFinancials,
    activeTickerData,
    activeTickerSymbol,
    closeAll,
    config: state.config,
    currentRoute,
    dataProvider,
    dispatch,
    focusedPaneId: state.focusedPaneId,
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
    tickers: state.tickers,
    updateTopRoute,
  });

  const getTickerSearchTickers = useCallback(() => stateRef.current.tickers, []);
  const hasPaneSettings = useCallback((paneId: string) => pluginRegistry.hasPaneSettings(paneId), [pluginRegistry]);

  const rootShortcutIntent = useMemo(() => parseRootShortcutIntent({
    query: rootQuery,
    commands: availableCommands,
    pluginCommands: getAvailablePluginCommands(),
    paneTemplates: getAvailablePaneShortcutTemplates(rootQuery),
    activeTicker: activeTickerSymbol,
  }), [activeTickerSymbol, availableCommands, getAvailablePaneShortcutTemplates, getAvailablePluginCommands, rootQuery]);

  const planAccess = usePlanAccess();
  const buildAssistInventory = useCallback(() => buildAssistCommandInventory({
    commands: availableCommands,
    pluginCommands: getAvailablePluginCommands(),
    paneTemplates: getAvailablePaneTemplates(undefined, { includePromptableTickerTemplates: true }),
  }), [availableCommands, getAvailablePaneTemplates, getAvailablePluginCommands]);
  // Only the root list asks on its own, and only for text the prefix parser
  // could not claim — otherwise the user is mid-command, not mid-question.
  const assistAutoAsk = !currentRoute
    && planAccess.emailVerified
    && shouldAutoAskAssist({ query: rootQuery, hasShortcutIntent: rootShortcutIntent.kind !== "none" });
  const { assistActive, assistState, askAssist, resetAssist } = useCommandBarAssist({
    autoAsk: assistAutoAsk,
    getInventory: buildAssistInventory,
    rootQuery,
  });
  // Filled in below once the selection runtime exists, so an AI candidate runs
  // through the very same submit path as text the user typed.
  const runRootQueryRef = useRef<
    ((query: string, options?: { fallbackPrefix?: string }) => void) | null
  >(null);
  const startAssistSignUp = useCallback(() => {
    const signUpCommand = getAvailablePluginCommands().find((command) => command.id === "auth-signup");
    if (signUpCommand?.wizard?.length) {
      openPluginCommandWorkflow(signUpCommand);
      return;
    }
    setRootQuery("Sign Up");
  }, [getAvailablePluginCommands, openPluginCommandWorkflow, setRootQuery]);
  const assist = useMemo<AssistRowHandlers>(() => ({
    enabled: planAccess.emailVerified,
    auto: assistAutoAsk && assistActive,
    state: assistState,
    onAsk: askAssist,
    onSignUp: startAssistSignUp,
    onRunCandidate: (input: string, prefix?: string) => runRootQueryRef.current?.(
      input,
      prefix ? { fallbackPrefix: prefix } : undefined,
    ),
  }), [askAssist, assistActive, assistAutoAsk, assistState, planAccess.emailVerified, startAssistSignUp]);

  const {
    activeMatch,
    orderedRootResults,
    rootGhostSuffix,
    rootSearching,
    rootSectionOrder,
    rootShortcutFeedback,
    tickerSearchPending,
    tickerSearchResults,
  } = useCommandBarRootRuntime({
    activeCollectionId,
    activePortfolio,
    activeTickerData,
    activeTickerSymbol,
    assist,
    availableCommands,
    buildLayoutItems,
    buildPaneSettingItems,
    buildPluginItems,
    buildTickerSearchResultItems,
    buildWindowModeItems,
    createPaneTemplateItem,
    createPluginCommandItem,
    currentRoute,
    dataProvider,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getTickers: getTickerSearchTickers,
    hasPaneSettings,
    localTickerSearchResultItems,
    nativeListScrollRef,
    nonShortcutPaneTemplateItems,
    openModeRoute,
    paneShortcutItems,
    pluginCommandItems,
    pluginCommandResultItems,
    readTickerSearchCache,
    rootModeKind: rootModeInfo.kind,
    rootQuery,
    rootShortcutIntent,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setRootHoveredIdx,
    setRootSelectedIdx,
    skipTickerSearchDebounceRef,
    state,
    tickerActionItems,
    writeTickerSearchCache,
  });
  const themePickerActive = !currentRoute && activeMatch?.command.id === "theme";
  const themePickerFilter = themePickerActive ? activeMatch.arg : "";

  const {
    acceptRootShortcutTab,
    acceptSelectedShortcutTab,
    activateListSelection,
    runRootQuery,
    setActiveListQuery,
  } = useCommandBarSelectionRuntime({
    activeTickerSymbol,
    availableCommands,
    clearThemePreview,
    closeAll,
    collectionWorkflowActions,
    createPaneTemplateItem,
    createPluginCommandItem,
    currentRoute,
    currentRouteRef,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openInlineConfirm,
    openModeRoute,
    openPaneTemplateWorkflow,
    persistLayoutChange,
    pluginCommandResultItems,
    pluginRegistry,
    rootModeKindRef,
    rootQuery,
    rootQueryRef,
    rootThemeBaseIdRef,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setRootQuery,
    setRouteStack,
    stateConfigLayout: state.config.layout,
    stateRef,
    updateTopRoute,
    updateWorkflowValue,
    visibleListStateRef,
  });
  runRootQueryRef.current = runRootQuery;

  const routeListState = useRouteListState({
    activeMatch,
    adaptTickerSearchRouteResult,
    buildLayoutItems,
    buildPaneSettingItems,
    buildPluginItems,
    currentRoute,
    orderedRootResults,
    pluginRegistry,
    rootHoveredIdx,
    rootModeKind: rootModeInfo.kind,
    rootQuery,
    rootSectionOrder,
    rootSearching,
    rootSelectedIdx,
    tickerSearchPending,
    tickerSearchResults,
  });
  useCommandBarRouteEffects({
    clearThemePreview,
    committedThemeId: state.config.theme,
    currentRoute,
    dataProvider,
    ensureRouteFieldFocus,
    lastMainBrowseRef,
    rootModeKind: rootModeInfo.kind,
    rootQuery,
    rootSelectedIdx,
    rootThemeBaseIdRef,
    updateTopRoute,
  });

  const panelProps = useCommandBarPanelRuntime({
    acceptRootShortcutTab,
    acceptSelectedShortcutTab,
    activateListSelection,
    applyThemePreview,
    cellHeightPx,
    cellWidthPx,
    closeAll,
    commitTheme,
    committedThemeId: state.config.theme,
    confirmCurrentRoute,
    currentRoute,
    currentRouteRef,
    dismissCommandBar,
    focusWorkflowField,
    getWorkflowInputRef,
    getWorkflowFieldStringValue,
    moveWorkflowFocus,
    nativeListScrollRef,
    nativePaneChrome,
    onNativeOccluderChange,
    openWorkflowFieldPicker,
    persistConfig,
    pluginRegistry,
    popRoute,
    resetAssist,
    rootModeKind: rootModeInfo.kind,
    rootGhostSuffix,
    rootQueryLength: rootQuery.length,
    rootShortcutFeedback,
    routeListState,
    setActiveListQuery,
    setRootHoveredIdx,
    setRootSelectedIdx,
    setRouteStack,
    setWorkflowNativeSelectRef,
    stateRef,
    submitWorkflowRoute,
    syncActiveWorkflowTextarea,
    termHeight,
    termWidth,
    themePickerActive,
    themePickerFilter,
    themePickerRef,
    titleBarOverlay,
    updateTopRoute,
    updateWorkflowValue,
    visibleListStateRef,
    workflowNativeSelectRefs,
    workflowScrollRef,
  });

  return (
    <CommandBarPanel {...panelProps} />
  );
}
