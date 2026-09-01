import { useCallback, useMemo, useRef } from "react";
import { useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { useViewport } from "../../../react/input";
import {
  getFocusedCollectionId,
  syncConfigActiveLayoutState,
  useAppDispatch,
  useAppSelector,
  useFocusedTicker,
  type AppState,
} from "../../../state/app/context";
import { scheduleConfigSave } from "../../../state/config-save-scheduler";
import { commands } from "../commands/registry";
import type { ThemePickerHandle } from "../theme-picker";
import type { ListScreenState } from "../list/model";

function useCommandBarAppState(): AppState {
  const config = useAppSelector((state) => state.config);
  const paneState = useAppSelector((state) => state.paneState);
  const tickers = useAppSelector((state) => state.tickers);
  const financials = useAppSelector((state) => state.financials);
  const focusedPaneId = useAppSelector((state) => state.focusedPaneId);
  const activePanel = useAppSelector((state) => state.activePanel);
  const layoutHistory = useAppSelector((state) => state.layoutHistory);
  const recentTickers = useAppSelector((state) => state.recentTickers);
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const commandBarQuery = useAppSelector((state) => state.commandBarQuery);
  const commandBarLaunchRequest = useAppSelector((state) => state.commandBarLaunchRequest);
  const updateAvailable = useAppSelector((state) => state.updateAvailable);
  const updateProgress = useAppSelector((state) => state.updateProgress);
  const updateCheckInProgress = useAppSelector((state) => state.updateCheckInProgress);
  const updateNotice = useAppSelector((state) => state.updateNotice);

  return useMemo(() => ({
    config,
    paneState,
    tickers,
    financials,
    focusedPaneId,
    activePanel,
    layoutHistory,
    recentTickers,
    commandBarOpen,
    commandBarQuery,
    commandBarLaunchRequest,
    updateAvailable,
    updateProgress,
    updateCheckInProgress,
    updateNotice,
  }) as AppState, [
    activePanel,
    commandBarLaunchRequest,
    commandBarOpen,
    commandBarQuery,
    config,
    financials,
    focusedPaneId,
    layoutHistory,
    paneState,
    recentTickers,
    tickers,
    updateAvailable,
    updateCheckInProgress,
    updateNotice,
    updateProgress,
  ]);
}

export function useCommandBarEnvironment() {
  const dispatch = useAppDispatch();
  const state = useCommandBarAppState();
  const stateRef = useRef(state);
  stateRef.current = state;
  const persistConfig = useCallback((nextConfig: AppState["config"]) => {
    const currentState = stateRef.current;
    scheduleConfigSave(syncConfigActiveLayoutState(
      nextConfig,
      currentState.paneState,
      currentState.focusedPaneId,
      currentState.activePanel,
    ));
  }, []);
  const { symbol: activeTickerSymbol, ticker: activeTickerData, financials: activeFinancials } = useFocusedTicker();
  const { width: termWidth, height: termHeight } = useViewport();
  const {
    nativePaneChrome: nativePaneChromeCapability,
    cellWidthPx = 8,
    cellHeightPx = 18,
    nativeWindowChrome,
    titleBarOverlay,
  } = useUiCapabilities();
  const nativePaneChrome = nativePaneChromeCapability === true;
  const availableCommands = useMemo(
    () => nativePaneChrome
      ? commands.filter((command) => command.id !== "cycle-chart-renderer")
      : commands,
    [nativePaneChrome],
  );
  const skipTickerSearchDebounceRef = useRef(false);
  const nativeListScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const themePickerRef = useRef<ThemePickerHandle | null>(null);
  const visibleListStateRef = useRef<ListScreenState | null>(null);
  const activeCollectionId = getFocusedCollectionId(state);
  const activePortfolio = state.config.portfolios.find((portfolio) => portfolio.id === activeCollectionId);
  const getCommittedThemeId = useCallback(() => stateRef.current.config.theme, []);

  return {
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
  };
}
