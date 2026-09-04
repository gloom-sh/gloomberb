import { expect } from "bun:test";
import { act, useReducer } from "react";
import { TestDialogProvider, testRender } from "../../../renderers/opentui/test-utils";
import { CommandBar } from "./index";
import {
  AppContext,
  type AppAction,
  type AppState,
  appReducer,
  createInitialState,
  getEffectiveThemeId,
} from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { ThemeProvider, useThemeId } from "../../../theme/theme-context";
import { cloneLayout, createDefaultConfig, TICKER_RESEARCH_PANE_ID, type AppConfig } from "../../../types/config";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import type { PluginRegistry } from "../../../plugins/registry";
import type { PaneSettingField } from "../../../types/plugin";
import { useShortcut } from "../../../react/input";
import { Box, Text } from "../../../ui";
import { Header } from "../../layout/header";

export async function emitKeypress(
  renderer: Awaited<ReturnType<typeof testRender>>,
  event: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; option?: boolean },
): Promise<void> {
  await act(async () => {
    renderer.renderer.keyInput.emit("keypress", {
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      eventType: "press",
      repeated: false,
      stopPropagation: () => {},
      preventDefault: () => {},
      ...event,
    } as any);
    await renderer.renderOnce();
  });
}

/**
 * Advances one polling step: sleeps, then renders. Both happen inside `act` so
 * that anything a resolving promise queued during the sleep is flushed before
 * the next frame is captured. Polling outside `act` leaves the update to
 * React's scheduler, which is why a loaded CI box could time out waiting for a
 * frame the app had already produced.
 */
export async function settleFrame(
  renderer: Awaited<ReturnType<typeof testRender>>,
  delayMs = 50,
): Promise<void> {
  await act(async () => {
    await Bun.sleep(delayMs);
    await renderer.renderOnce();
  });
}

/**
 * Turns a poll count into a wall-clock budget.
 *
 * Counting attempts assumes every attempt costs about `delayMs`, which is only
 * true on an idle machine: on a loaded CI runner each render can cost more than
 * the sleep, so a caller asking for 40 attempts got its 2s budget spent well
 * before the app had a chance to answer. The count is kept as the caller's
 * unit, then floored so a slow machine waits longer rather than failing.
 */
function waitBudgetMs(attempts: number, delayMs: number): number {
  return Math.max(attempts * delayMs, 10_000);
}

export function createCommandBarTestControls(
  getRenderer: () => Awaited<ReturnType<typeof testRender>>,
) {
  const waitForFrameToContain = async (text: string, attempts = 12, delayMs = 50): Promise<string> => {
    const renderer = getRenderer();
    const deadline = Date.now() + waitBudgetMs(attempts, delayMs);
    do {
      const frame = renderer.captureCharFrame();
      if (frame.includes(text)) {
        return frame;
      }
      await settleFrame(renderer, delayMs);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for frame to contain "${text}".`);
  };

  const clickFrameText = async (text: string): Promise<void> => {
    const renderer = getRenderer();
    const frame = renderer.captureCharFrame();
    const rows = frame.split("\n");
    const row = rows.findIndex((line) => line.includes(text));
    const col = row >= 0 ? rows[row]!.indexOf(text) : -1;

    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await renderer.mockMouse.click(col + 1, row);
      await renderer.renderOnce();
    });
  };

  const renderFrames = async (count = 2): Promise<void> => {
    const renderer = getRenderer();
    for (let index = 0; index < count; index += 1) {
      await act(async () => {
        await renderer.renderOnce();
      });
    }
  };

  return {
    waitForFrameToContain,
    clickFrameText,
    renderFrames,
  };
}

export function expectSingleBackControl(frame: string): void {
  expect(frame.match(/\bBack\b/g)?.length ?? 0).toBe(1);
}

export function makeTicker(
  symbol: string,
  name: string,
  overrides: Partial<TickerRecord["metadata"]> = {},
): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
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
}) {
  let config = {
    ...createDefaultConfig("/tmp/gloomberb-test"),
    recentTickers: ["AAPL", "MSFT"],
    disabledPlugins,
  };
  if (configureConfig) {
    config = configureConfig(config);
  }
  const tickers = [makeTicker("AAPL", "Apple Inc."), makeTicker("MSFT", "Microsoft Corp."), ...extraTickers];
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
  const [liveState, dispatch] = useReducer(appReducer, state);
  const currentState = live ? liveState : state;
  const currentDispatch = live
    ? (action: AppAction) => {
      onAction?.(action);
      dispatch(action);
    }
    : (_action: AppAction) => {};

  return (
    <ThemeProvider themeId={getEffectiveThemeId(currentState)}>
      <AppContext value={{ state: currentState, dispatch: currentDispatch }}>
        <TestDialogProvider>
          {/* The header hosts the bar's input while it is open, so typing in a
              test needs the real header on the first row. */}
          <Header />
          <Box flexGrow={1} />
          {/* The sheet spans the full width and can reach as far down as
              termHeight - 6 (panel/layout.ts), so probes live on the bottom row,
              the one place no sheet height can cover. */}
          <Box flexDirection="row" gap={1} height={1}>
            {live && <ThemeProbe />}
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
          {onUnhandledEnter && <UnhandledEnterProbe onEnter={onUnhandledEnter} />}
        </TestDialogProvider>
      </AppContext>
    </ThemeProvider>
  );
}
