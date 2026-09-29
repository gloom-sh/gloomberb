import { expect } from "bun:test";
import { useLayoutEffect, useMemo, useReducer, useRef, type Dispatch } from "react";
import { AppDialogBridge } from "../../../app/dialog-bridge";
import type { PluginRegistry } from "../../../plugins/registry";
import { useShortcut } from "../../../react/input";
import { RemoteUiRegistryProvider, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import {
  AppContext,
  appReducer,
  createInitialState,
  getEffectiveThemeId,
  type AppAction,
  type AppContextStoreValue,
  type AppState,
} from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { ThemeProvider, useThemeId } from "../../../theme/theme-context";
import { TICKER_RESEARCH_PANE_ID, cloneLayout, createDefaultConfig, type AppConfig } from "../../../types/config";
import type { DataProvider } from "../../../types/data-provider";
import type { PaneSettingField } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { Box, Text } from "../../../ui";
import { Header } from "../../layout/header";
import { FormModalHost } from "../../form-modal";
import { CommandBar } from "./index";
import { createTestTicker } from "../../../test-support/ticker";

export { createTestControls as createCommandBarTestControls, emitKeypress, settleFrame } from "../../../renderers/opentui/test-utils";

export function expectSingleBackControl(frame: string): void {
  expect(frame.match(/\bBack\b/g)?.length ?? 0).toBe(1);
}

export function makeDataProvider(searchImpl: DataProvider["search"] = async () => []): DataProvider {
  return createTestDataProvider({
    id: "test",
    search: searchImpl,
  });
}

function makePluginRegistry(hasPaneSettings: (paneId: string) => boolean = () => false): PluginRegistry {
  return {
    panes: new Map<string, any>([
      ["portfolio-list", {
        id: "portfolio-list",
        name: "Portfolio List",
        component: () => null,
        defaultPosition: "left",
      }],
      [TICKER_RESEARCH_PANE_ID, {
        id: TICKER_RESEARCH_PANE_ID,
        name: "Ticker Research",
        component: () => null,
        defaultPosition: "right",
      }],
      ["chat", {
        id: "chat",
        name: "Chat",
        component: () => null,
        defaultPosition: "right",
        defaultMode: "floating",
      }],
      ["quote-monitor", {
        id: "quote-monitor",
        name: "Quote Monitor",
        component: () => null,
        defaultPosition: "right",
        defaultMode: "floating",
      }],
      ["ibkr-trading", {
        id: "ibkr-trading",
        name: "IBKR Console",
        component: () => null,
        defaultPosition: "right",
        defaultMode: "floating",
      }],
    ]),
    paneTemplates: new Map<string, any>([
      ["new-portfolio-pane", {
        id: "new-portfolio-pane",
        paneId: "portfolio-list",
        label: "New Portfolio Pane",
        description: "Open another portfolio list pane",
        shortcut: { prefix: "PF" },
      }],
      ["new-watchlist-pane", {
        id: "new-watchlist-pane",
        paneId: "portfolio-list",
        label: "New Watchlist Pane",
        description: "Open another watchlist pane",
      }],
      ["new-ticker-detail-pane", {
        id: "new-ticker-detail-pane",
        paneId: TICKER_RESEARCH_PANE_ID,
        label: "Ticker Research",
        description: "Open another research pane",
        shortcut: { prefix: "T", argPlaceholder: "ticker", argKind: "ticker" },
      }],
      ["new-chat-pane", {
        id: "new-chat-pane",
        paneId: "chat",
        label: "New Chat Pane",
        description: "Open another floating chat window",
        shortcut: { prefix: "CHAT", argPlaceholder: "channel", argKind: "text" },
      }],
      ["quote-monitor-pane", {
        id: "quote-monitor-pane",
        paneId: "quote-monitor",
        label: "Quote Monitor",
        description: "Open a compact quote monitor for one or more tickers",
        shortcut: { prefix: "QQ", argPlaceholder: "tickers", argKind: "ticker-list" },
        wizard: [{ key: "tickers", label: "Quote Tickers", type: "text" }],
      }],
      ["new-ibkr-trading-pane", {
        id: "new-ibkr-trading-pane",
        paneId: "ibkr-trading",
        label: "New IBKR Trading Pane",
        description: "Open another floating IBKR trading console",
        shortcut: { prefix: "IBKR" },
        canCreate: (context: any) => context.config.brokerInstances.some((instance: any) => (
          instance.brokerType === "ibkr"
          && instance.connectionMode === "gateway"
          && instance.enabled !== false
        )),
      }],
    ]),
    commands: new Map<string, any>([
      ["plugin:scan", {
        id: "plugin:scan",
        label: "Scan Movers",
        description: "Run a quick movers scan",
        category: "plugins",
        execute: async () => {},
      }],
    ]),
    commandBarSearchProviders: new Map<string, any>(),
    getCommandBarSearchProviderPluginId: () => undefined,
    getEnabledTickerActions() { return [...this.tickerActions.values()]; },
    tickerActions: new Map<string, any>([
      ["pin", {
        id: "pin",
        label: "Pin Ticker",
        execute: async () => {},
      }],
    ]),
    brokers: new Map(),
    allPlugins: new Map([
      ["news", { id: "news", name: "News", version: "1.0.0", description: "Latest headlines", toggleable: true }],
      ["notes", { id: "notes", name: "Notes", version: "1.0.0", description: "Ticker notes", toggleable: true }],
    ]),
    getCommandPluginId: () => "news",
    getPaneTemplatePluginId: (templateId: string) => (
      templateId === "new-chat-pane" ? "news" : "notes"
    ),
    getPluginPaneIds: () => [],
    getPluginPaneTemplateIds: () => [],
    hasPaneSettings,
    events: { emit: () => {} },
    hidePane: () => {},
    pinTicker: () => {},
    showPane: () => {},
    openWindowMode: () => {},
    openWindowModeFn: () => {},
    updateLayoutFn: () => {},
    getTermSizeFn: () => ({ width: 80, height: 24 }),
    notify: () => {},
    createPaneFromTemplateFn: () => {},
    createPaneFromTemplateAsyncFn: async () => {},
    openPaneSettingsFn: () => {},
    applyPaneSettingValueFn: async () => {},
    resolvePaneSettings: () => null,
    createBrokerInstanceFn: async () => { throw new Error("unused"); },
    syncBrokerInstanceFn: async () => {},
    removeBrokerInstanceFn: async () => {},
    getConfigFn: () => createDefaultConfig("/tmp/gloomberb-test"),
  } as unknown as PluginRegistry;
}

export function makeQuoteMonitorPaneSettingsDescriptor(
  pluginRegistry: PluginRegistry,
  fields: PaneSettingField[],
  settings: Record<string, unknown> = {},
) {
  const config = createDefaultConfig("/tmp/gloomberb-test");
  const pane = {
    instanceId: "quote-monitor:main",
    paneId: "quote-monitor",
    title: "Quote Monitor",
    settings,
  };
  return {
    paneId: "quote-monitor:main",
    pane,
    paneDef: pluginRegistry.panes.get("quote-monitor")!,
    settingsDef: {
      title: "Quote Monitor Settings",
      fields,
    },
    context: {
      config,
      layout: cloneLayout(config.layout),
      paneId: "quote-monitor:main",
      paneType: "quote-monitor",
      pane,
      settings,
      paneState: {},
      activeTicker: "AAPL",
      activeCollectionId: "main",
    },
  } as any;
}

/**
 * A store like the app's: one object for the life of the harness, current
 * the moment an action is dispatched, so a form or a confirm that outlives
 * the bar still reads the latest state.
 */
function useLiveAppStore(initialState: AppState, onAction?: (action: AppAction) => void): { state: AppState; store: AppContextStoreValue } {
  const [state, reactDispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const listenersRef = useRef(new Set<() => void>());
  const store = useMemo<AppContextStoreValue>(() => ({
    dispatch: ((action: AppAction) => {
      stateRef.current = appReducer(stateRef.current, action);
      onActionRef.current?.(action);
      reactDispatch(action);
    }) as Dispatch<AppAction>,
    getState: () => stateRef.current,
    subscribe: (listener) => {
      listenersRef.current.add(listener);
      return () => {
        listenersRef.current.delete(listener);
      };
    },
  }), []);
  useLayoutEffect(() => {
    stateRef.current = state;
    for (const listener of listenersRef.current) listener();
  }, [state]);
  return { state, store };
}

function ThemeProbe() {
  return <Text>{`theme:${useThemeId()}`}</Text>;
}

function UnhandledEnterProbe({ onEnter }: { onEnter: () => void }) {
  useShortcut((event) => {
    if (event.name === "enter" || event.name === "return") {
      onEnter();
    }
  });
  return null;
}

export function CommandBarHarness({
  query,
  disabledPlugins = [],
  selectedTicker,
  live = false,
  extraTickers = [],
  showQueryState = false,
  onSaveTicker,
  configureConfig,
  configureState,
  configurePluginRegistry,
  dataProvider = makeDataProvider(),
  hasPaneSettings,
  onCheckForUpdates,
  onAction,
  onUnhandledEnter,
  onDispatch,
  remoteRegistry,
  storeRef,
}: {
  query: string;
  disabledPlugins?: string[];
  selectedTicker?: string;
  live?: boolean;
  extraTickers?: TickerRecord[];
  showQueryState?: boolean;
  onSaveTicker?: (ticker: TickerRecord) => void;
  configureConfig?: (config: AppConfig) => AppConfig;
  configureState?: (state: AppState) => AppState;
  configurePluginRegistry?: (pluginRegistry: PluginRegistry) => void;
  dataProvider?: DataProvider;
  hasPaneSettings?: (paneId: string) => boolean;
  onCheckForUpdates?: () => void | Promise<void>;
  onAction?: (action: AppAction) => void;
  onUnhandledEnter?: () => void;
  /** Hands the live dispatch to the test, to act as a menu or another window would. */
  onDispatch?: (dispatch: (action: AppAction) => void) => void;
  /** The registry the app would own, to see what remote control sees. */
  remoteRegistry?: RemoteUiRegistry;
  /** Receives the live store, to dispatch as the rest of the app would. */
  storeRef?: { current: AppContextStoreValue | null };
}) {
  let config = {
    ...createDefaultConfig("/tmp/gloomberb-test"),
    recentTickers: ["AAPL", "MSFT"],
    disabledPlugins,
  };
  if (configureConfig) {
    config = configureConfig(config);
  }
  const tickers = [createTestTicker("AAPL", "Apple Inc."), createTestTicker("MSFT", "Microsoft Corp."), ...extraTickers];
  let state: AppState = {
    ...createInitialState(config),
    commandBarOpen: true,
    commandBarQuery: query,
    focusedPaneId: "portfolio-list:main",
    tickers: new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker])),
    config: { ...config, disabledPlugins },
    paneState: selectedTicker
      ? {
        "portfolio-list:main": {
          collectionId: "main",
          cursorSymbol: selectedTicker,
        },
      }
      : createInitialState(config).paneState,
  };
  if (configureState) {
    state = configureState(state);
  }
  const tickerRepository = {
    loadTicker: async () => null,
    createTicker: async (metadata: TickerRecord["metadata"]) => ({
      metadata,
    }),
    saveTicker: async (ticker: TickerRecord) => {
      onSaveTicker?.(ticker);
    },
  };
  const pluginRegistry = makePluginRegistry(hasPaneSettings);
  configurePluginRegistry?.(pluginRegistry);
  const liveStore = useLiveAppStore(state, onAction);
  const currentState = live ? liveStore.state : state;
  const store = live ? liveStore.store : createStaticAppStore(state);
  if (storeRef) storeRef.current = store;
  onDispatch?.(store.dispatch);

  // The dialog host is testRender's, outside this tree, as it is outside the
  // app in production: dialogs reach the store only through the bridge.
  return (
    <RemoteUiRegistryProvider registry={remoteRegistry}>
      <ThemeProvider themeId={getEffectiveThemeId(currentState)}>
        <AppContext value={store}>
          <AppDialogBridge />
          {/* The header hosts the bar's input while it is open, so typing in a
              test needs the real header on the first row. */}
          <Header />
          <Box flexGrow={1} />
          {/* The sheet spans the full width and can reach as far down as
              termHeight - 6 (panel/layout.ts), so probes live on the bottom row,
              the one place no sheet height can cover. */}
          <Box flexDirection="row" gap={1} height={1}>
            {live && <ThemeProbe />}
            {live && <Text>{currentState.commandBarOpen ? "bar:open" : "bar:closed"}</Text>}
            {showQueryState && <Text>{`query:${currentState.commandBarQuery}`}</Text>}
          </Box>
          {currentState.commandBarOpen && (
            <CommandBar
              dataProvider={dataProvider}
              tickerRepository={tickerRepository as any}
              pluginRegistry={pluginRegistry}
              quitApp={() => {}}
              onCheckForUpdates={onCheckForUpdates}
            />
          )}
          <FormModalHost
            dataProvider={dataProvider}
            pluginRegistry={pluginRegistry}
            tickerRepository={tickerRepository as any}
          />
          {onUnhandledEnter && <UnhandledEnterProbe onEnter={onUnhandledEnter} />}
        </AppContext>
      </ThemeProvider>
    </RemoteUiRegistryProvider>
  );
}
