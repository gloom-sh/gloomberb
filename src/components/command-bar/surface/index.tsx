import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DataProvider } from "../../../types/data-provider";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import type { LayoutBounds } from "../../../plugins/pane-manager";
import { usePlanAccess } from "../../../api-client/plan-access";
import { buildAssistCommandInventory } from "../assist/inventory";
import { useCommandBarAssist } from "../assist/runtime";
import { shouldAutoAskAssist, type AssistRowHandlers } from "../assist/model";
import { automationActive, usageTelemetryAllowed } from "../../../telemetry/usage-counts";

/** Command-bar prefix of the assistant pane. */
const ASKG_SHORTCUT_PREFIX = "ASKG";
import {
  getAvailableCommandBarSearchProviders,
  useCommandBarSearchProviders,
} from "../routes/root/search-providers";
import { openUrl } from "../../ui/external-link";
import { useRouteListState } from "../routing/list-state";
import { useCommandBarRootRuntime } from "../routes/root/runtime";
import { useCommandSearchReport } from "../routes/root/search-report";
import { useAppStateRef } from "../../../state/app/context";
import { parseRootShortcutIntent } from "../routes/root/shortcuts";
import { useRootPluginInstallItem } from "../routes/root/plugin-install";
import { useCommandBarThemePreview } from "../theme-preview";
import { matchThemeOptions } from "../theme-picker";
import { CommandBarPanel } from "../panel";
import { useCommandBarNavigationState } from "../routing/navigation-state";
import { useCommandBarSelectionRuntime } from "../selection-runtime";
import { useCommandBarPanelRuntime } from "../panel/runtime";
import { useCommandBarRouteEffects } from "../routing/effects";
import { useCommandBarEnvironment } from "./environment";
import { useCommandBarActionRuntime } from "../action-runtime";
import { requestKeybindingCapture } from "../../../app/keybindings";

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
    availableCommands: allAvailableCommands,
    cellHeightPx,
    cellWidthPx,
    dispatch,
    getCommittedThemeId,
    nativeListScrollRef,
    nativePaneChrome,
    nativeWindowChrome,
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
  const availableCommands = useMemo(() => onCheckForUpdates
    ? allAvailableCommands
    : allAvailableCommands.filter((command) => command.id !== "check-for-updates"), [allAvailableCommands, onCheckForUpdates]);
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
    isAutomationQuery,
    lastMainBrowseRef,
    openingQuery,
    markRootSelectionNavigated,
    popRoute,
    pushRoute,
    rootHoveredIdx,
    rootModeInfo,
    rootModeKindRef,
    rootQuery,
    rootQueryRef,
    rootSelectionNavigatedRef,
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

  // Searches follow the Usage setting, both what the AI may keep and the
  // report. Read from the live store: turning Usage off from the bar must
  // count at once, not at the bar's next render (it may never render again).
  const liveStateRef = useAppStateRef();
  const searchLoggingAllowed = useCallback(() => usageTelemetryAllowed(liveStateRef.current.config), [liveStateRef]);
  // Filled in below, once the assist runtime has run.
  const searchIdForRef = useRef<(query: string) => string | undefined>(() => undefined);
  const searchIdFor = useCallback((query: string) => searchIdForRef.current(query), []);
  const {
    choose: chooseSearchResult,
    dismiss: dismissSearchReport,
    finish: finishSearchReport,
    runRootRow,
    settle: settleSearchReport,
  } = useCommandSearchReport({
    currentRouteRef,
    isAutomationQuery,
    isEnabled: searchLoggingAllowed,
    openingQuery,
    rootQueryRef,
    routeOpen: currentRoute !== null,
    searchIdFor,
  });
  // Every close that follows something running goes through here, so the
  // search report sends what ran rather than a dismissal. Esc, a click outside
  // the bar and the bar's own key close without it.
  const closeAfterRun = useCallback((options?: { revertThemePreview?: boolean }) => {
    finishSearchReport();
    closeAll(options);
  }, [closeAll, finishSearchReport]);
  // A click outside the bar, read before closing clears the route it was on.
  const dismissOverlay = useCallback(() => {
    dismissSearchReport();
    closeAll();
  }, [closeAll, dismissSearchReport]);

  const {
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
    setWorkflowSelectFieldRef,
    submitWorkflowRoute,
    syncActiveWorkflowTextarea,
    tickerActionItems,
    updateWorkflowValue,
    workflowSelectFieldRefs,
    workflowScrollRef,
    writeTickerSearchCache,
  } = useCommandBarActionRuntime({
    activeCollectionId,
    activeFinancials,
    activeTickerData,
    activeTickerSymbol,
    closeAll: closeAfterRun,
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

  // Runs the typed text again once a plugin installed from the bar is in, the
  // way a key bound to it would.
  const rerunQuery = useCallback((query: string) => {
    dispatch({ type: "SET_COMMAND_BAR", open: true, query, launch: { kind: "run-query", query } });
  }, [dispatch]);
  const closeBar = useCallback(() => closeAfterRun({ revertThemePreview: false }), [closeAfterRun]);
  const pluginInstallItem = useRootPluginInstallItem({
    enabled: !currentRoute && rootShortcutIntent.kind === "none",
    query: rootQuery,
    commands: allAvailableCommands,
    pluginRegistry,
    openInlineConfirm,
    rerunQuery,
    closeBar,
  });

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
  // The server keeps a question unless told not to, so the answer always
  // goes out: false with the Usage setting off or for text remote control typed.
  const logSearches = useCallback((query: string) => (
    searchLoggingAllowed() && !automationActive() && !isAutomationQuery(query)
  ), [isAutomationQuery, searchLoggingAllowed]);
  const { assistActive, assistState, askAssist, resetAssist, searchIdFor: assistSearchIdFor } = useCommandBarAssist({
    autoAsk: assistAutoAsk,
    getInventory: buildAssistInventory,
    logSearches,
    rootQuery,
  });
  searchIdForRef.current = assistSearchIdFor;
  // Filled in below once the selection runtime exists, so an AI candidate runs
  // through the very same submit path as text the user typed.
  const runRootQueryRef = useRef<
    ((query: string, options?: { fallbackPrefix?: string }) => boolean) | null
  >(null);
  /**
   * Query whose answer the user is already waiting on, set by activating the
   * "Thinking…" row. The row leads the list and holds the default selection, so
   * Enter has to mean something even before the answer is back: it claims the
   * answer, and the best candidate runs the moment it lands.
   */
  const assistPendingRunRef = useRef<string | null>(null);
  const askAssistNow = useCallback(() => {
    assistPendingRunRef.current = rootQueryRef.current.trim();
    askAssist();
  }, [askAssist, rootQueryRef]);
  useEffect(() => {
    const pendingQuery = assistPendingRunRef.current;
    if (!pendingQuery) return;
    // Still the very ask that was claimed; nothing to do until it answers.
    if (assistState.status === "loading" && assistState.query === pendingQuery) return;
    assistPendingRunRef.current = null;
    if (assistState.status !== "answered" || assistState.query !== pendingQuery) return;
    // Typing moved on, so the answer is no longer what the user is looking at.
    if (rootQueryRef.current.trim() !== pendingQuery) return;
    const candidate = assistState.candidates[0];
    if (!candidate) return;
    const run = () => {
      runRootQueryRef.current?.(
        candidate.input,
        candidate.prefix ? { fallbackPrefix: candidate.prefix } : undefined,
      );
    };
    // The claimed answer is the first AI row, which is what the user picked.
    const listState = visibleListStateRef.current;
    const rank = listState?.kind === "root"
      ? listState.results.findIndex((item) => item.searchChoice?.kind === "assist")
      : -1;
    const row = rank >= 0 ? listState?.results[rank] : undefined;
    if (row) runRootRow({ item: row, query: rootQueryRef.current, rank, isShortcut: () => false }, run);
    else run();
  }, [assistState, rootQueryRef, runRootRow, visibleListStateRef]);
  const startAssistSignUp = useCallback(() => {
    const signUpCommand = getAvailablePluginCommands().find((command) => command.id === "auth-signup");
    if (signUpCommand?.wizard?.length) {
      openPluginCommandWorkflow(signUpCommand);
      return;
    }
    setRootQuery("Sign Up");
  }, [getAvailablePluginCommands, openPluginCommandWorkflow, setRootQuery]);
  // The assistant pane ships with the cloud plugin, so the row only exists
  // while that pane template is registered.
  const askGloomTemplate = useMemo(() => (
    getAvailablePaneTemplates(undefined, { includePromptableTickerTemplates: true })
      .find((template) => template.shortcut?.prefix?.toUpperCase() === ASKG_SHORTCUT_PREFIX)
      ?? null
  ), [getAvailablePaneTemplates]);
  const assist = useMemo<AssistRowHandlers>(() => ({
    enabled: planAccess.emailVerified,
    auto: assistAutoAsk && assistActive,
    state: assistState,
    onAsk: askAssistNow,
    onSignUp: startAssistSignUp,
    onRunCandidate: (input: string, prefix?: string) => runRootQueryRef.current?.(
      input,
      prefix ? { fallbackPrefix: prefix } : undefined,
    ),
    // Runs through the same submit path as typing the shortcut by hand.
    ...(askGloomTemplate
      ? {
        onAskGloom: (question: string) => runRootQueryRef.current?.(
          `${ASKG_SHORTCUT_PREFIX} ${question}`,
          { fallbackPrefix: ASKG_SHORTCUT_PREFIX },
        ),
      }
      : {}),
  }), [askAssistNow, askGloomTemplate, assistActive, assistAutoAsk, assistState, planAccess.emailVerified, startAssistSignUp]);

  // The bar cannot capture a key while it owns the keyboard, so the request
  // goes to Help > Shortcuts, which captures once the bar is gone.
  const bindKey = useCallback((query: string) => {
    requestKeybindingCapture({ kind: "command", query });
    closeAfterRun({ revertThemePreview: false });
    pluginRegistry.showPane("help");
  }, [closeAfterRun, pluginRegistry]);

  const searchProviders = useMemo(
    () => getAvailableCommandBarSearchProviders(pluginRegistry, state.config.disabledPlugins),
    [pluginRegistry, state.config.disabledPlugins],
  );
  const searchProviderContext = useMemo(() => ({
    activeTicker: activeTickerSymbol,
    activeCollectionId,
  }), [activeCollectionId, activeTickerSymbol]);
  const closeAfterProviderResult = useCallback(() => {
    closeAfterRun({ revertThemePreview: false });
  }, [closeAfterRun]);
  const { providerResultItems, providerSearching } = useCommandBarSearchProviders({
    providers: searchProviders,
    query: rootQuery,
    // A resolved prefix means the user is running a command, so free-text
    // providers neither ask the network nor add rows.
    enabled: !currentRoute && rootShortcutIntent.kind === "none",
    context: searchProviderContext,
    onExecuted: closeAfterProviderResult,
  });
  const providerCategoryPriorities = useMemo(
    () => new Map(searchProviders.map((provider) => [provider.category, provider.priority ?? 0])),
    [searchProviders],
  );

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
    bindKey,
    buildLayoutItems,
    buildPaneSettingItems,
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
    pluginInstallItem,
    providerResultItems,
    providerCategoryPriorities,
    providerSearching,
    readTickerSearchCache,
    rootModeKind: rootModeInfo.kind,
    rootQuery,
    rootSelectionNavigatedRef,
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
  // A theme picked from the root ("TH dracula", Enter) is the typed shortcut
  // running, so the visit reports it as it closes.
  const commitRootTheme = useCallback((themeId: string) => {
    if (!currentRouteRef.current) {
      const themes = matchThemeOptions(themePickerFilter);
      const rank = themes.findIndex((theme) => theme.id === themeId);
      chooseSearchResult(rootQueryRef.current, {
        kind: "shortcut",
        label: themes[rank]?.name ?? themeId,
        input: rootQueryRef.current.trim(),
        rank: Math.max(0, rank),
        category: "Themes",
        fromAssist: false,
      });
    }
    commitTheme(themeId);
  }, [chooseSearchResult, commitTheme, currentRouteRef, rootQueryRef, themePickerFilter]);

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
    closeAll: closeAfterRun,
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
    runRootRow,
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

  // A key bound to command bar text opens the bar with a run-query launch:
  // the text is submitted exactly as if typed and entered, once per request,
  // and text the parser cannot run stays in the input. What a key runs is not
  // a search, so the visit ends with no report.
  const processedRunQuerySequenceRef = useRef<number | null>(null);
  useEffect(() => {
    const launch = state.commandBarLaunchRequest;
    if (!launch || launch.kind !== "run-query" || !state.commandBarOpen) return;
    if (processedRunQuerySequenceRef.current === launch.sequence) return;
    processedRunQuerySequenceRef.current = launch.sequence;
    if (runRootQuery(launch.query)) settleSearchReport();
  }, [runRootQuery, settleSearchReport, state.commandBarLaunchRequest, state.commandBarOpen]);

  const routeListState = useRouteListState({
    activeMatch,
    adaptTickerSearchRouteResult,
    buildLayoutItems,
    buildPaneSettingItems,
    currentRoute,
    orderedRootResults,
    pluginRegistry,
    rootCategoryPriorities: providerCategoryPriorities,
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
    closeAll: closeAfterRun,
    commitTheme: commitRootTheme,
    committedThemeId: state.config.theme,
    confirmCurrentRoute,
    currentRoute,
    currentRouteRef,
    dismissCommandBar,
    dismissOverlay,
    focusWorkflowField,
    getWorkflowInputRef,
    getWorkflowFieldStringValue,
    markRootSelectionNavigated,
    moveWorkflowFocus,
    nativeListScrollRef,
    nativePaneChrome,
    nativeWindowChrome,
    onNativeOccluderChange,
    openWorkflowFieldPicker,
    persistConfig,
    pluginRegistry,
    popRoute,
    resetAssist,
    rootModeKind: rootModeInfo.kind,
    rootGhostSuffix,
    rootShortcutFeedback,
    routeListState,
    setActiveListQuery,
    setRootHoveredIdx,
    setRootSelectedIdx,
    setRouteStack,
    setWorkflowSelectFieldRef,
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
    workflowSelectFieldRefs,
    workflowScrollRef,
  });

  return (
    <CommandBarPanel {...panelProps} />
  );
}
