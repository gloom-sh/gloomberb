import { createTestRenderer } from "@opentui/core/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { PluginRegistry } from "../plugins/registry";
import { TestDialogProvider, createOpenTuiTestRoot as createRoot, emitKeypress as emitTuiKeypress, type TestKeyEvent } from "../renderers/opentui/test-utils";
import { createInitialState, type AppAction, type AppState } from "../state/app/context";
import { cloneLayout, createDefaultConfig, type KeybindingsConfig } from "../types/config";
import type { ReleaseInfo } from "../updater";
import { useAppGlobalShortcuts } from "./global-shortcuts";
import { resolveKeybindings } from "./keybindings";

let testSetup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
    root = undefined;
  }
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

function createRegistry(
  shortcutExecute?: () => void,
  onShowPane?: (paneId: string) => void,
): PluginRegistry {
  return {
    shortcuts: new Map(shortcutExecute
      ? [["test-shortcut", { id: "test-shortcut", key: "x", execute: shortcutExecute }]]
      : []),
    panes: new Map([
      ["portfolio-list", {}],
      ["ticker-research", {}],
      ["chat", {}],
      ["help", {}],
    ]),
    getPluginPaneIds: () => [],
    getShortcutPluginId: () => null,
    showPane: onShowPane ?? (() => {}),
  } as unknown as PluginRegistry;
}

function ShortcutHarness({
  dispatch,
  focusedTickerSymbol = null,
  pluginRegistry,
  refreshTicker = () => {},
  startUpdate = () => {},
  state,
}: {
  dispatch: (action: AppAction) => void;
  focusedTickerSymbol?: string | null;
  pluginRegistry: PluginRegistry;
  refreshTicker?: (symbol: string, exchange?: string, tickerOverride?: any, priority?: number) => void;
  startUpdate?: (release: ReleaseInfo) => void;
  state: AppState;
}) {
  useAppGlobalShortcuts({
    dispatch,
    focusedTickerSymbol,
    isDetachedWindow: false,
    keybindings: resolveKeybindings(state.config.keybindings),
    pluginRegistry,
    refreshTicker,
    startUpdate,
    state,
  });
  return <text>ready</text>;
}

function stateWithKeybindings(suffix: string, keybindings: KeybindingsConfig, options: Partial<AppState> = {}): AppState {
  const config = createDefaultConfig(`/tmp/gloomberb-global-shortcuts-${suffix}`);
  config.keybindings = keybindings;
  return { ...createInitialState(config), ...options };
}

async function renderHarness(
  state: AppState,
  registry: PluginRegistry,
  dispatch: (action: AppAction) => void,
  options: {
    focusedTickerSymbol?: string | null;
    refreshTicker?: (symbol: string, exchange?: string, tickerOverride?: any, priority?: number) => void;
    startUpdate?: (release: ReleaseInfo) => void;
  } = {},
) {
  testSetup = await createTestRenderer({ width: 40, height: 8 });
  root = createRoot(testSetup.renderer);
  act(() => {
    root!.render(
      <TestDialogProvider>
        <ShortcutHarness
          dispatch={dispatch}
          focusedTickerSymbol={options.focusedTickerSymbol}
          pluginRegistry={registry}
          refreshTicker={options.refreshTicker}
          startUpdate={options.startUpdate}
          state={state}
        />
      </TestDialogProvider>,
    );
  });
  await act(async () => {
    await testSetup!.renderOnce();
  });
}

/** The OpenTUI input host derives `targetEditable` from the focused editor. */
function focusEditor() {
  Object.defineProperty(testSetup!.renderer, "currentFocusedEditor", {
    configurable: true,
    get: () => ({}),
  });
}

const emitKeypress = (event: TestKeyEvent) => emitTuiKeypress(testSetup!, event, { trackPropagation: true });

describe("useAppGlobalShortcuts", () => {
  test("toggles the command bar with Ctrl-P", async () => {
    const actions: AppAction[] = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts"));
    await renderHarness(state, createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "p", ctrl: true });

    expect(actions).toEqual([{ type: "TOGGLE_COMMAND_BAR" }]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("toggles the command bar with Ctrl-K", async () => {
    const actions: AppAction[] = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts"));
    await renderHarness(state, createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "k", ctrl: true });

    expect(actions).toEqual([{ type: "TOGGLE_COMMAND_BAR" }]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  // The open bar moves its selection on Ctrl+P, so that chord must reach it.
  test("leaves Ctrl-P to the open command bar and still closes it with Ctrl-K", async () => {
    const actions: AppAction[] = [];
    const state = { ...createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts-open-bar")), commandBarOpen: true };
    await renderHarness(state, createRegistry(), (action) => actions.push(action));

    const up = await emitKeypress({ name: "p", ctrl: true });
    expect(actions).toEqual([]);
    expect(up.defaultPrevented).toBe(false);

    await emitKeypress({ name: "k", ctrl: true });
    expect(actions).toEqual([{ type: "TOGGLE_COMMAND_BAR" }]);
  });

  test("U retries a failed self-update", async () => {
    const started: string[] = [];
    const release = { version: "9.9.9", updateAction: { kind: "self" } } as unknown as ReleaseInfo;
    const failed = {
      ...createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts-update")),
      updateAvailable: release,
      updateProgress: { phase: "error" as const, error: "network" },
    };
    await renderHarness(failed, createRegistry(), () => {}, { startUpdate: (next) => started.push(next.version) });

    const retry = await emitKeypress({ name: "u" });
    expect(started).toEqual(["9.9.9"]);
    expect(retry.defaultPrevented).toBe(true);
  });

  test("opens ticker search with backtick", async () => {
    const actions: AppAction[] = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts"));
    await renderHarness(state, createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "`" });

    expect(actions).toEqual([{
      type: "SET_COMMAND_BAR",
      open: true,
      query: "",
      launch: { kind: "ticker-search", query: "" },
    }]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("a rebound action answers to its new key and not the old one", async () => {
    const actions: AppAction[] = [];
    const state = stateWithKeybindings("rebound", {
      actions: { "ticker-search": "Ctrl+Shift+S", "command-bar": "Ctrl+Shift+P", help: null },
    });
    const openedPanes: string[] = [];
    await renderHarness(state, createRegistry(undefined, (paneId) => openedPanes.push(paneId)), (action) => actions.push(action));

    const oldKey = await emitKeypress({ name: "`" });
    expect(actions).toEqual([]);
    expect(oldKey.defaultPrevented).toBe(false);

    await emitKeypress({ name: "s", ctrl: true, shift: true });
    expect(actions).toEqual([{
      type: "SET_COMMAND_BAR",
      open: true,
      query: "",
      launch: { kind: "ticker-search", query: "" },
    }]);

    await emitKeypress({ name: "p", ctrl: true });
    expect(actions).toHaveLength(1);
    await emitKeypress({ name: "p", ctrl: true, shift: true });
    expect(actions[1]).toEqual({ type: "TOGGLE_COMMAND_BAR" });

    const help = await emitKeypress({ name: "?", shift: true });
    expect(openedPanes).toEqual([]);
    expect(help.defaultPrevented).toBe(false);
  });

  test("a command binding opens the bar with the text to run, unless the bar or a dialog owns the keyboard", async () => {
    const actions: AppAction[] = [];
    const state = stateWithKeybindings("command", { commands: { "Alt+1": "DES AAPL" } });
    await renderHarness(state, createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "1", alt: true });

    expect(actions).toEqual([{
      type: "SET_COMMAND_BAR",
      open: true,
      query: "DES AAPL",
      launch: { kind: "run-query", query: "DES AAPL" },
    }]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("a Control command binding yields to the editor while text is being typed", async () => {
    const actions: AppAction[] = [];
    const state = stateWithKeybindings("command-typing", { commands: { "Ctrl+N": "NEWS", F5: "NEWS" } }, { inputCaptured: true });
    await renderHarness(state, createRegistry(), (action) => actions.push(action));

    const ctrl = await emitKeypress({ name: "n", ctrl: true });
    expect(actions).toEqual([]);
    expect(ctrl.defaultPrevented).toBe(false);

    await emitKeypress({ name: "f5" });
    expect(actions).toEqual([{
      type: "SET_COMMAND_BAR",
      open: true,
      query: "NEWS",
      launch: { kind: "run-query", query: "NEWS" },
    }]);
  });

  test("a plugin shortcut honours its override", async () => {
    let executed = 0;
    const state = stateWithKeybindings("plugin-override", { actions: { "plugin:test-shortcut": "Alt+X" } });
    await renderHarness(state, createRegistry(() => { executed += 1; }), () => {});

    await emitKeypress({ name: "x" });
    expect(executed).toBe(0);
    await emitKeypress({ name: "x", alt: true });
    expect(executed).toBe(1);
  });

  function layoutState(suffix: string, options: { commandBarOpen?: boolean } = {}) {
    const config = createDefaultConfig(`/tmp/gloomberb-global-shortcuts-${suffix}`);
    config.layouts = [
      { name: "One", layout: cloneLayout(config.layout) },
      { name: "Two", layout: cloneLayout(config.layout) },
      { name: "Three", layout: cloneLayout(config.layout) },
    ];
    config.activeLayoutIndex = 0;
    return { ...createInitialState(config), ...options };
  }

  test("switches saved layouts with Ctrl-number and consumes the shortcut", async () => {
    const actions: AppAction[] = [];
    await renderHarness(layoutState("layouts"), createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "2", ctrl: true });

    expect(actions).toEqual([{ type: "SWITCH_LAYOUT", index: 1 }]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  // Browsers and the desktop webview report Cmd as meta; the OpenTUI host maps
  // the kitty `super` modifier onto the same field.
  test("switches saved layouts with the Cmd-number reported by web and kitty hosts", async () => {
    const actions: AppAction[] = [];
    await renderHarness(layoutState("layouts-meta"), createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "3", super: true });

    expect(actions).toEqual([{ type: "SWITCH_LAYOUT", index: 2 }]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  // Alt-digit keeps its terminal meaning; only the primary modifier switches.
  test("ignores Alt-number", async () => {
    const actions: AppAction[] = [];
    await renderHarness(layoutState("layouts-alt"), createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "2", alt: true });

    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  // Leaving the digit unclaimed lets the desktop webview treat Cmd-digit as its
  // own browser tab shortcut, which navigates the app away.
  test("consumes layout numbers while the command bar is open without switching", async () => {
    const actions: AppAction[] = [];
    await renderHarness(
      layoutState("layouts-command-bar", { commandBarOpen: true }),
      createRegistry(),
      (action) => actions.push(action),
    );

    const event = await emitKeypress({ name: "2", ctrl: true });

    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("consumes primary-modifier numbers with only one layout", async () => {
    const actions: AppAction[] = [];
    const config = createDefaultConfig("/tmp/gloomberb-global-shortcuts-one-layout");
    const state = { ...createInitialState(config), commandBarOpen: true };
    await renderHarness(state, createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "1", super: true });

    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("consumes layout numbers while an editable field owns the keyboard", async () => {
    const actions: AppAction[] = [];
    await renderHarness(layoutState("layouts-editable"), createRegistry(), (action) => actions.push(action));
    focusEditor();

    const event = await emitKeypress({ name: "2", super: true });

    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("does not run plain plugin shortcuts while input is captured", async () => {
    let executed = 0;
    const actions: AppAction[] = [];
    const state = {
      ...createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts-captured")),
      inputCaptured: true,
    };
    await renderHarness(state, createRegistry(() => {
      executed += 1;
    }), (action) => actions.push(action));

    const event = await emitKeypress({ name: "x" });

    expect(executed).toBe(0);
    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
  });

  test("opens Help with question mark after the command bar is closed", async () => {
    const openedPanes: string[] = [];
    const actions: AppAction[] = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts-help"));
    await renderHarness(state, createRegistry(undefined, (paneId) => openedPanes.push(paneId)), (action) => actions.push(action));

    const event = await emitKeypress({ name: "?", shift: true });

    expect(openedPanes).toEqual(["help"]);
    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("does not open Help with question mark while using the command bar", async () => {
    const openedPanes: string[] = [];
    const actions: AppAction[] = [];
    const config = createDefaultConfig("/tmp/gloomberb-global-shortcuts-help-guard");
    const commandBarState = {
      ...createInitialState(config),
      commandBarOpen: true,
    };
    await renderHarness(commandBarState, createRegistry(undefined, (paneId) => openedPanes.push(paneId)), (action) => actions.push(action));

    let event = await emitKeypress({ name: "?", shift: true });
    expect(openedPanes).toEqual([]);
    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
  });

  test("does not open Help with question mark while typing", async () => {
    const openedPanes: string[] = [];
    const actions: AppAction[] = [];
    const config = createDefaultConfig("/tmp/gloomberb-global-shortcuts-help-input");
    const inputCapturedState = {
      ...createInitialState(config),
      inputCaptured: true,
    };
    await renderHarness(inputCapturedState, createRegistry(undefined, (paneId) => openedPanes.push(paneId)), (action) => actions.push(action));

    const event = await emitKeypress({ name: "?", shift: true });
    expect(openedPanes).toEqual([]);
    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
  });

  test("cycles panes with Tab while input is captured", async () => {
    const actions: AppAction[] = [];
    const state = {
      ...createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts-tab-captured")),
      inputCaptured: true,
    };
    await renderHarness(state, createRegistry(), (action) => actions.push(action));

    const event = await emitKeypress({ name: "tab" });

    expect(actions).toEqual([{
      type: "FOCUS_NEXT",
      paneOrder: [
        "portfolio-list:main",
        "chat:main",
        "ticker-detail:main",
      ],
    }]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("does not treat modified Shift-R as force refresh", async () => {
    const refreshes: Array<{ symbol: string; priority?: number }> = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts-resize"));
    state.tickers.set("AAPL", {
      metadata: { ticker: "AAPL", exchange: "NASDAQ" },
    } as any);
    await renderHarness(state, createRegistry(), () => {}, {
      refreshTicker: (symbol, _exchange, _ticker, priority) => {
        refreshes.push({ symbol, priority });
      },
    });

    const event = await emitKeypress({ name: "r", ctrl: true, shift: true });

    expect(refreshes).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
  });
});
