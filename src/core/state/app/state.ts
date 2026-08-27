import type { AppConfig } from "../../../types/config";
import { resolveTickerFinancialsQuoteState } from "../../../market-data/quotes/resolution";
import {
  bringFloatingToFront,
  clearTickerBindings,
  clonePaneStateMap,
  focusPaneState,
  getActiveSavedPaneState,
  getEffectiveThemeId,
  getFocusedCollectionId,
  getFocusedTickerSymbol,
  getPaneOrder,
  getPanelFocusTarget,
  getTopFloatingPaneId,
  hydrateDesktopSnapshot,
  nextRecentTickers,
  reconcilePaneState,
  resolveCollectionForPane,
  resolveTickerForPane,
  syncConfigActiveLayoutState,
  withFocusedPane,
} from "./layout";
import { reduceLayoutAction } from "./layout-reducer";
import type { AppAction, AppState, CollectionSortPreference, PaneRuntimeState } from "./types";
import type { AppSessionSnapshot } from "../session-persistence";

export {
  clonePaneStateMap,
  getEffectiveThemeId,
  getFocusedCollectionId,
  getFocusedTickerSymbol,
  resolveCollectionForPane,
  resolveTickerForPane,
  syncConfigActiveLayoutState,
};
export type { AppAction, AppState, CollectionSortPreference, PaneRuntimeState };

export function appReducer(state: AppState, action: AppAction): AppState {
  const layoutState = reduceLayoutAction(state, action);
  if (layoutState) return layoutState;

  switch (action.type) {
    case "SET_CONFIG":
      return withFocusedPane(
        { ...state, themePreview: null, layoutHistory: {} },
        action.config,
        {
          paneState: {
            ...state.paneState,
            ...(getActiveSavedPaneState(action.config) ?? {}),
          },
        },
      );

    case "SET_ONBOARDING_STATE":
      return {
        ...state,
        config: {
          ...state.config,
          onboardingComplete: action.complete,
          onboardingProgress: action.progress,
        },
      };

    case "SET_TICKERS":
      return { ...state, tickers: action.tickers };

    case "UPDATE_TICKER": {
      const tickers = new Map(state.tickers);
      tickers.set(action.ticker.metadata.ticker, action.ticker);
      return { ...state, tickers };
    }

    case "REMOVE_TICKER": {
      const tickers = new Map(state.tickers);
      tickers.delete(action.symbol);
      const financials = new Map(state.financials);
      financials.delete(action.symbol);
      const paneState: Record<string, PaneRuntimeState> = {};
      for (const [paneId, currentState] of Object.entries(state.paneState)) {
        paneState[paneId] = currentState.cursorSymbol === action.symbol
          ? { ...currentState, cursorSymbol: null }
          : currentState;
      }
      const layout = clearTickerBindings(state.config.layout, action.symbol);
      return withFocusedPane({
        ...state,
        tickers,
        financials,
        paneState,
        recentTickers: state.recentTickers.filter((symbol) => symbol !== action.symbol),
      }, { ...state.config, layout }, { paneState });
    }

    case "SET_FINANCIALS": {
      const financials = new Map(state.financials);
      financials.set(action.symbol, resolveTickerFinancialsQuoteState(action.data)!);
      return { ...state, financials };
    }

    case "MERGE_QUOTE": {
      const financials = new Map(state.financials);
      const current = state.financials.get(action.symbol);
      financials.set(action.symbol, resolveTickerFinancialsQuoteState(current, action.quote)!);
      return { ...state, financials };
    }

    case "HYDRATE_FINANCIALS": {
      if (action.financials.size === 0) return state;
      const financials = new Map(state.financials);
      for (const [symbol, data] of action.financials) {
        financials.set(symbol, resolveTickerFinancialsQuoteState(data)!);
      }
      return { ...state, financials };
    }

    case "TRACK_TICKER":
      return { ...state, recentTickers: nextRecentTickers(state.recentTickers, action.symbol) };

    case "SET_ACTIVE_PANEL": {
      const firstPane = action.preserveFocus
        ? state.focusedPaneId
        : getPanelFocusTarget(state.config.layout, action.panel);
      return withFocusedPane(state, state.config, {
        activePanel: action.panel,
        focusedPaneId: firstPane ?? state.focusedPaneId,
      });
    }

    case "TOGGLE_COMMAND_BAR":
      return state.commandBarOpen
        ? { ...state, commandBarOpen: false, commandBarQuery: "", commandBarLaunchRequest: null, themePreview: null }
        : { ...state, commandBarOpen: true, commandBarQuery: "", commandBarLaunchRequest: null };

    case "SET_COMMAND_BAR": {
      const launchRequest = action.open && action.launch
        ? {
            ...action.launch,
            sequence: (state.commandBarLaunchRequest?.sequence ?? 0) + 1,
          }
        : null;
      return {
        ...state,
        commandBarOpen: action.open,
        commandBarQuery: action.open ? (action.query ?? "") : "",
        commandBarLaunchRequest: launchRequest,
        themePreview: action.open ? state.themePreview : null,
      };
    }

    case "SET_COMMAND_BAR_QUERY":
      return { ...state, commandBarQuery: action.query };

    case "SET_REFRESHING": {
      const refreshing = new Set(state.refreshing);
      if (action.refreshing) refreshing.add(action.symbol);
      else refreshing.delete(action.symbol);
      return { ...state, refreshing };
    }

    case "SET_BROKER_ACCOUNTS":
      return {
        ...state,
        brokerAccounts: {
          ...state.brokerAccounts,
          [action.instanceId]: action.accounts,
        },
      };

    case "SET_INITIALIZED":
      return { ...state, initialized: true };

    case "TOGGLE_STATUS_BAR":
      return { ...state, statusBarVisible: !state.statusBarVisible };

    case "SET_THEME":
      if (state.config.theme === action.theme && state.themePreview == null) return state;
      return { ...state, themePreview: null, config: { ...state.config, theme: action.theme } };

    case "PREVIEW_THEME":
      if (state.themePreview === action.theme) return state;
      return { ...state, themePreview: action.theme };

    case "SET_UPDATE_AVAILABLE":
      return { ...state, updateAvailable: action.release, updateNotice: action.release ? null : state.updateNotice };

    case "SET_UPDATE_PROGRESS":
      return { ...state, updateProgress: action.progress, updateNotice: action.progress ? null : state.updateNotice };

    case "SET_UPDATE_CHECK_IN_PROGRESS":
      return { ...state, updateCheckInProgress: action.checking };

    case "SET_UPDATE_NOTICE":
      return { ...state, updateNotice: action.notice };

    case "TOGGLE_PLUGIN": {
      const disabledPlugins = state.config.disabledPlugins.includes(action.pluginId)
        ? state.config.disabledPlugins.filter((pluginId) => pluginId !== action.pluginId)
        : [...state.config.disabledPlugins, action.pluginId];
      return { ...state, config: { ...state.config, disabledPlugins } };
    }

    case "SET_INPUT_CAPTURED":
      return { ...state, inputCaptured: action.captured };

    case "SET_EXCHANGE_RATE": {
      const exchangeRates = new Map(state.exchangeRates);
      exchangeRates.set(action.currency, action.rate);
      return { ...state, exchangeRates };
    }

    case "HYDRATE_EXCHANGE_RATES": {
      if (action.exchangeRates.size === 0) return state;
      const exchangeRates = new Map(state.exchangeRates);
      for (const [currency, rate] of action.exchangeRates) {
        exchangeRates.set(currency, rate);
      }
      return { ...state, exchangeRates };
    }

    case "FOCUS_PANE": {
      return focusPaneState(state, action.paneId);
    }

    case "FOCUS_NEXT": {
      if (action.paneOrder.length === 0) return state;
      const currentIndex = state.focusedPaneId ? action.paneOrder.indexOf(state.focusedPaneId) : -1;
      const nextPaneId = action.paneOrder[(currentIndex + 1) % action.paneOrder.length]!;
      return focusPaneState(state, nextPaneId);
    }

    case "FOCUS_PREV": {
      if (action.paneOrder.length === 0) return state;
      const focusedIndex = state.focusedPaneId ? action.paneOrder.indexOf(state.focusedPaneId) : -1;
      const currentIndex = focusedIndex >= 0 ? focusedIndex : 0;
      const nextPaneId = action.paneOrder[(currentIndex - 1 + action.paneOrder.length) % action.paneOrder.length]!;
      return focusPaneState(state, nextPaneId);
    }

    case "HYDRATE_DESKTOP_SNAPSHOT":
      return hydrateDesktopSnapshot(state, action.snapshot);

    case "UPDATE_PANE_STATE": {
      const current = state.paneState[action.paneId] ?? {};
      if (Object.keys(action.patch).every((key) => Object.is(current[key], action.patch[key]))) {
        return state;
      }
      const nextState = { ...current, ...action.patch };
      const recentTickers = Object.prototype.hasOwnProperty.call(action.patch, "cursorSymbol")
        ? nextRecentTickers(state.recentTickers, typeof nextState.cursorSymbol === "string" ? nextState.cursorSymbol : null)
        : state.recentTickers;
      const paneState = {
        ...state.paneState,
        [action.paneId]: nextState,
      };
      return {
        ...state,
        config: syncConfigActiveLayoutState(state.config, paneState, state.focusedPaneId, state.activePanel),
        paneState,
        recentTickers,
      };
    }

    case "REPLACE_PANE_STATE": {
      const current = state.paneState[action.paneId] ?? {};
      const nextState = action.state;
      if (Object.is(current, nextState)) return state;
      const paneState = {
        ...state.paneState,
        [action.paneId]: nextState,
      };
      const recentTickers = current.cursorSymbol !== nextState.cursorSymbol
        ? nextRecentTickers(state.recentTickers, typeof nextState.cursorSymbol === "string" ? nextState.cursorSymbol : null)
        : state.recentTickers;
      return {
        ...state,
        config: syncConfigActiveLayoutState(state.config, paneState, state.focusedPaneId, state.activePanel),
        paneState,
        recentTickers,
      };
    }

    case "UPDATE_PLUGIN_PANE_STATE": {
      const current = state.paneState[action.paneId] ?? {};
      const currentPluginState = current.pluginState ?? {};
      const currentPluginValues = currentPluginState[action.pluginId] ?? {};
      if (Object.is(currentPluginValues[action.key], action.value)) {
        return state;
      }
      const paneState = {
        ...state.paneState,
        [action.paneId]: {
          ...current,
          pluginState: {
            ...currentPluginState,
            [action.pluginId]: {
              ...currentPluginValues,
              [action.key]: action.value,
            },
          },
        },
      };
      return {
        ...state,
        config: syncConfigActiveLayoutState(state.config, paneState, state.focusedPaneId, state.activePanel),
        paneState,
      };
    }

    default:
      return state;
  }
}

export function createInitialState(config: AppConfig, sessionSnapshot: AppSessionSnapshot | null = null): AppState {
  const activeSavedLayout = config.layouts[config.activeLayoutIndex];
  const savedPaneState = activeSavedLayout?.paneState ? clonePaneStateMap(activeSavedLayout.paneState) : {};
  const sessionPaneState = sessionSnapshot?.paneState ? clonePaneStateMap(sessionSnapshot.paneState) : {};
  const paneState = reconcilePaneState(config, { ...sessionPaneState, ...savedPaneState });
  const defaultFocusedPaneId = getTopFloatingPaneId(config.layout) ?? getPaneOrder(config.layout)[0] ?? null;
  const requestedFocusedPaneId = activeSavedLayout?.focusedPaneId ?? sessionSnapshot?.focusedPaneId ?? null;
  const focusedPaneId = requestedFocusedPaneId
    && config.layout.instances.some((instance) => instance.instanceId === requestedFocusedPaneId)
    ? requestedFocusedPaneId
    : defaultFocusedPaneId;
  const activePanel = activeSavedLayout?.activePanel ?? (sessionSnapshot?.activePanel === "right" ? "right" : "left");
  const focusedLayout = focusedPaneId ? bringFloatingToFront(config.layout, focusedPaneId) : config.layout;
  const focusedConfig = syncConfigActiveLayoutState(
    focusedLayout === config.layout ? config : { ...config, layout: focusedLayout },
    paneState,
    focusedPaneId,
    activePanel,
  );
  return {
    config: focusedConfig,
    tickers: new Map(),
    financials: new Map(),
    exchangeRates: new Map([["USD", 1]]),
    brokerAccounts: {},
    activePanel,
    focusedPaneId,
    previousFocusedPaneId: null,
    paneState,
    recentTickers: config.recentTickers,
    commandBarOpen: false,
    commandBarQuery: "",
    commandBarLaunchRequest: null,
    themePreview: null,
    refreshing: new Set(),
    initialized: false,
    statusBarVisible: sessionSnapshot?.statusBarVisible !== false,
    inputCaptured: false,
    updateAvailable: null,
    updateProgress: null,
    updateCheckInProgress: false,
    updateNotice: null,
    layoutHistory: {},
  };
}
