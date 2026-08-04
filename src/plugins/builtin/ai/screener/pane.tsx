import { Box, Text } from "../../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaneProps } from "../../../../types/plugin";
import { TICKER_RESEARCH_PANE_ID } from "../../../../types/config";
import {
  useAppDispatch,
  useAppSelector,
  usePaneInstance,
  usePaneInstanceId,
} from "../../../../state/app/context";
import {
  useAssetData,
  usePluginConfigState,
  usePluginPaneState,
  usePluginState,
  usePluginTickerActions,
} from "../../../runtime";
import { type DataTableKeyEvent } from "../../../../components";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { getAiProvider, resolveDefaultAiProviderId } from "../providers";
import { useAiRuntimeProviders } from "../use-runtime-providers";
import {
  getSelectableAiRunners,
  isAiProviderReady,
  resolveReadyAiRunnerDefault,
} from "../runner-selection";
import {
  matchesScreenerPromptSignature,
} from "./contract";
import {
  EMPTY_PANE_STATE,
  EMPTY_SORT,
  createScreenerTab,
  getResultMap,
  normalizeTabs,
  type AiScreenerTab,
  type PersistedAiScreenerPaneState,
  type ScreenerSortPreference,
} from "./model";
import { getAiScreenerPaneSettings, resolveVisibleAiScreenerColumns } from "../settings";
import { AiScreenerEditorView } from "./editor";
import { AiScreenerResultsView } from "./results-view";
import { useAiScreenerRunner } from "./runner";
import { useAiScreenerMarketRuntime } from "./market-runtime";
import { useAiScreenerFooter } from "./footer";
import { useAiScreenerEditorRuntime } from "./editor-runtime";
import { useAiScreenerKeyboard } from "./keyboard";
import { AiScreenerTabsBar } from "./tabs-bar";
import {
  AI_DEFAULT_MODEL_SETTING_KEY,
  AI_DEFAULT_PROVIDER_SETTING_KEY,
  resolveAiPaneSelection,
} from "../pane-settings";
import { useLiveStreamingSetting } from "../../shared/live-streaming";

export function AiScreenerPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const { pinTicker } = usePluginTickerActions();
  const paneId = usePaneInstanceId();
  const paneInstance = usePaneInstance();
  const liveStreaming = useLiveStreamingSetting();
  const dispatch = useAppDispatch();
  const tickers = useAppSelector((state) => state.tickers);
  const providers = useAiRuntimeProviders();
  const selectableProviders = getSelectableAiRunners(providers, { outputMode: "screener" });
  const readyProviders = selectableProviders.filter(isAiProviderReady);
  const fallbackProviderId = resolveDefaultAiProviderId(selectableProviders);
  const [configuredDefaultProviderId] = usePluginConfigState<string>(
    AI_DEFAULT_PROVIDER_SETTING_KEY,
    fallbackProviderId,
  );
  const [configuredDefaultModelId] = usePluginConfigState<string>(AI_DEFAULT_MODEL_SETTING_KEY, "");
  const defaults = resolveReadyAiRunnerDefault(
    selectableProviders,
    configuredDefaultProviderId,
    configuredDefaultModelId,
  );
  const defaultProviderId = defaults.providerId;
  const defaultModelId = defaults.modelId;
  const [persistedState, setPersistedState] = usePluginState<PersistedAiScreenerPaneState>(
    `screener-pane:${paneId}`,
    EMPTY_PANE_STATE,
    { schemaVersion: 1 },
  );
  const [activeTabId, setActiveTabId] = usePluginPaneState<string | null>("activeTabId", null);
  const [cursorSymbol, setCursorSymbol] = usePluginPaneState<string | null>("cursorSymbol", null);
  const [sorts, setSorts] = usePluginPaneState<Record<string, ScreenerSortPreference>>("sorts", {});
  const [now, setNow] = useState(Date.now());
  const initializedRef = useRef(false);
  const pendingInitialRunRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const tabs = useMemo(() => normalizeTabs(persistedState), [persistedState]);
  const paneSettings = useMemo(
    () => getAiScreenerPaneSettings(paneInstance?.settings),
    [paneInstance?.settings],
  );
  const columns = useMemo(
    () => resolveVisibleAiScreenerColumns(paneSettings.columnIds),
    [paneSettings.columnIds],
  );

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (tabs.length > 0) return;

    const seedPrompt = typeof paneInstance?.params?.prompt === "string"
      ? paneInstance.params.prompt.trim()
      : "";
    if (!seedPrompt) return;

    const seedProviderId = typeof paneInstance?.params?.providerId === "string"
      ? paneInstance.params.providerId
      : defaultProviderId;
    const seedModelId = typeof paneInstance?.params?.modelId === "string"
      ? paneInstance.params.modelId.trim() || null
      : defaultModelId;
    const seededTab = createScreenerTab(seedPrompt, seedProviderId, seedModelId);
    pendingInitialRunRef.current = seededTab.id;
    setPersistedState({ tabs: [seededTab] });
    setActiveTabId(seededTab.id);
  }, [defaultModelId, defaultProviderId, paneInstance?.params?.modelId, paneInstance?.params?.prompt, paneInstance?.params?.providerId, setActiveTabId, setPersistedState, tabs.length]);

  useEffect(() => {
    if (tabs.length === 0) {
      if (activeTabId !== null) setActiveTabId(null);
      if (cursorSymbol !== null) setCursorSymbol(null);
      return;
    }
    if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(tabs[0]!.id);
    }
  }, [activeTabId, cursorSymbol, setActiveTabId, setCursorSymbol, tabs]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const resolveTabSelection = useCallback((tab: AiScreenerTab) => resolveAiPaneSelection({
    settings: paneInstance?.settings,
    savedProviderId: tab.providerId,
    savedModelId: tab.modelId,
    defaultProviderId,
    defaultModelId,
  }), [defaultModelId, defaultProviderId, paneInstance?.settings]);
  const activeSelection = activeTab ? resolveTabSelection(activeTab) : null;
  const resultMap = useMemo(() => getResultMap(activeTab), [activeTab]);
  const activeSort = activeTab ? sorts[activeTab.id] ?? EMPTY_SORT : EMPTY_SORT;
  const promptDirty = activeTab
    ? !matchesScreenerPromptSignature(
      activeTab.lastRunPromptSignature,
      activeTab.prompt,
      activeSelection ? activeSelection.providerId : activeTab.providerId,
      activeSelection ? activeSelection.modelId : activeTab.modelId,
    )
    : false;

  const {
    columnContext,
    financialsMap,
    sortedTickers,
  } = useAiScreenerMarketRuntime({
    activeSort,
    activeTab,
    columns,
    cursorSymbol,
    now,
    resultMap,
    setCursorSymbol,
    tickers,
    liveStreaming,
  });

  const updateTabs = useCallback((updater: (tabs: AiScreenerTab[]) => AiScreenerTab[]) => {
    setPersistedState((current) => ({
      tabs: updater(normalizeTabs(current)),
    }));
  }, [setPersistedState]);

  const upsertTab = useCallback((tabId: string, updater: (tab: AiScreenerTab) => AiScreenerTab) => {
    updateTabs((current) => current.map((tab) => (tab.id === tabId ? updater(tab) : tab)));
  }, [updateTabs]);

  const queueInitialRun = useCallback((tabId: string) => {
    pendingInitialRunRef.current = tabId;
  }, []);

  const {
    closeEditor,
    cycleEditorProvider,
    editorFocusTarget,
    editorModelInputRef,
    editorState,
    editorTextareaRef,
    focusEditorModel,
    focusEditorPrompt,
    openCreateEditor: openCreateEditorDraft,
    openEditEditor: openEditEditorDraft,
    saveEditor,
    selectEditorProvider,
    setEditorState,
  } = useAiScreenerEditorRuntime({
    defaultModelId,
    defaultProviderId,
    providers,
    queueInitialRun,
    selectableProviders,
    setActiveTabId,
    setCursorSymbol,
    updateTabs,
    upsertTab,
  });

  const openCreateEditor = useCallback(() => {
    openCreateEditorDraft();
  }, [openCreateEditorDraft]);

  const openEditEditor = useCallback((tab: AiScreenerTab | null) => {
    openEditEditorDraft(tab);
  }, [openEditEditorDraft]);

  const {
    cancelRun,
    runState,
    runTab,
  } = useAiScreenerRunner({
    dataProvider,
    dispatch,
    providers,
    resolveSelection: resolveTabSelection,
    tabs,
    tickers,
    upsertTab,
  });
  const isRunningActiveTab = runState?.tabId === activeTab?.id;

  const addTab = useCallback(() => {
    openCreateEditor();
  }, [openCreateEditor]);

  const removeTab = useCallback((tabId: string) => {
    if (runState?.tabId === tabId) {
      cancelRun();
    }
    setEditorState((current) => current?.tabId === tabId ? null : current);
    updateTabs((current) => current.filter((tab) => tab.id !== tabId));
    if (activeTabId === tabId) {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      const fallback = tabs.filter((tab) => tab.id !== tabId)[Math.max(0, index - 1)] ?? null;
      setActiveTabId(fallback?.id ?? null);
      setCursorSymbol(null);
    }
  }, [activeTabId, cancelRun, runState?.tabId, setActiveTabId, setCursorSymbol, tabs, updateTabs]);

  const editTab = useCallback((tab: AiScreenerTab | null) => {
    openEditEditor(tab);
  }, [openEditEditor]);

  const editActiveTab = useCallback(() => {
    editTab(activeTab);
  }, [activeTab, editTab]);

  useEffect(() => {
    if (!pendingInitialRunRef.current) return;
    if (!tabs.some((tab) => tab.id === pendingInitialRunRef.current)) return;
    const targetTabId = pendingInitialRunRef.current;
    pendingInitialRunRef.current = null;
    void runTab(targetTabId);
  }, [runTab, tabs]);

  const cycleTabs = useCallback((direction: -1 | 1) => {
    if (!activeTab || tabs.length <= 1) return;
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab.id);
    if (currentIndex < 0) return;
    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    setActiveTabId(tabs[nextIndex]!.id);
    setCursorSymbol(null);
  }, [activeTab, setActiveTabId, setCursorSymbol, tabs]);

  const handleHeaderClick = useCallback((columnId: string) => {
    if (!activeTab) return;
    const current = sorts[activeTab.id] ?? EMPTY_SORT;
    const next = current.columnId === columnId
      ? (current.direction === "asc"
        ? { columnId, direction: "desc" as const }
        : EMPTY_SORT)
      : { columnId, direction: "asc" as const };
    setSorts({
      ...sorts,
      [activeTab.id]: next,
    });
  }, [activeTab, setSorts, sorts]);

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    const isEnter = event.name === "enter" || event.name === "return";
    if (!isEnter || !cursorSymbol) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    pinTicker(cursorSymbol, {
      floating: !!event.shift,
      paneType: TICKER_RESEARCH_PANE_ID,
    });
    return true;
  }, [cursorSymbol, pinTicker]);

  const contentHeight = Math.max(height - 3, 4);
  const editorProvider = editorState ? getAiProvider(editorState.providerId, providers) : null;
  const refreshActiveTab = useCallback(() => {
    if (!activeTab || isRunningActiveTab) return;
    void runTab(activeTab.id);
  }, [activeTab, isRunningActiveTab, runTab]);

  useAiScreenerKeyboard({
    activeTab,
    addTab,
    cancelRun,
    closeEditor,
    cycleEditorProvider,
    cycleTabs,
    editActiveTab,
    editorFocusTarget,
    editorState,
    focused,
    focusEditorModel,
    focusEditorPrompt,
    isRunningActiveTab,
    refreshActiveTab,
    removeTab,
    saveEditor,
  });

  useAiScreenerFooter({
    activeTab,
    editorState,
    isRunningActiveTab,
    runState,
    onAddTab: addTab,
    onCancelRun: cancelRun,
    onCloseEditor: closeEditor,
    onEdit: editActiveTab,
    onRefresh: refreshActiveTab,
    onSaveEditor: saveEditor,
  });

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1}>
        <AiScreenerTabsBar
          activeTab={activeTab}
          addTab={addTab}
          editTab={editTab}
          editorState={editorState}
          focused={focused}
          removeTab={removeTab}
          setActiveTabId={setActiveTabId}
          setCursorSymbol={setCursorSymbol}
          tabs={tabs}
        />
      </Box>

      {readyProviders.length === 0 && (
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          <Text fg={colors.textDim}>{t("No AI providers are ready. Connect an account in pane settings.")}</Text>
        </Box>
      )}

      {editorState ? (
        <AiScreenerEditorView
          editorProvider={editorProvider}
          editorFocusTarget={editorFocusTarget}
          editorState={editorState}
          focused={focused}
          modelInputRef={editorModelInputRef}
          selectableProviders={selectableProviders}
          textareaRef={editorTextareaRef}
          onModelFocusRequest={focusEditorModel}
          onProviderChange={selectEditorProvider}
          onModelChange={(modelId) => {
            setEditorState((current) => current
              ? { ...current, modelId, error: null }
              : current);
          }}
          onPromptFocusRequest={focusEditorPrompt}
        />
      ) : (
        <AiScreenerResultsView
          activeSort={activeSort}
          activeTab={activeTab}
          columnContext={columnContext}
          columns={columns}
          contentHeight={contentHeight}
          cursorSymbol={cursorSymbol}
          financialsMap={financialsMap}
          focused={focused}
          isRunningActiveTab={isRunningActiveTab}
          promptDirty={promptDirty}
          resultMap={resultMap}
          setCursorSymbol={setCursorSymbol}
          sortedTickers={sortedTickers}
          width={width}
          onHeaderClick={handleHeaderClick}
          onRootKeyDown={handleTableKeyDown}
          onRowActivate={(ticker) => {
            pinTicker(ticker.metadata.ticker, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
          }}
        />
      )}
    </Box>
  );
}
