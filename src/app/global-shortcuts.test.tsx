import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { PluginRegistry } from "../plugins/registry";
import { TestDialogProvider, createOpenTuiTestHarness, type TestKeyEvent } from "../renderers/opentui/test-utils";
import { createInitialState, type AppAction, type AppState } from "../state/app/context";
import { cloneLayout, createDefaultConfig, type KeybindingsConfig } from "../types/config";
import type { ReleaseInfo } from "../updater";
import { useAppGlobalShortcuts } from "./global-shortcuts";
import { resolveKeybindings } from "./keybindings";

const tui = createOpenTuiTestHarness({ width: 40, height: 8 });

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
  restartToApplyUpdate = () => {},
  startUpdate = () => {},
  state,
}: {
  dispatch: (action: AppAction) => void;
  focusedTickerSymbol?: string | null;
  pluginRegistry: PluginRegistry;
  refreshTicker?: (symbol: string, exchange?: string, tickerOverride?: any, priority?: number) => void;
  restartToApplyUpdate?: () => void;
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
    restartToApplyUpdate,
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
    restartToApplyUpdate?: () => void;
    startUpdate?: (release: ReleaseInfo) => void;
  } = {},
) {
  await tui.render(
    <TestDialogProvider>
      <ShortcutHarness
        dispatch={dispatch}
        focusedTickerSymbol={options.focusedTickerSymbol}
        pluginRegistry={registry}
        refreshTicker={options.refreshTicker}
        restartToApplyUpdate={options.restartToApplyUpdate}
        startUpdate={options.startUpdate}
        state={state}
      />
    </TestDialogProvider>,
  );
  await act(async () => {
    await tui.setup().renderOnce();
  });
}

/** The OpenTUI input host derives `targetEditable` from the focused editor. */
function focusEditor() {
  Object.defineProperty(tui.setup().renderer, "currentFocusedEditor", {
    configurable: true,
    get: () => ({}),
  });
}

const emitKeypress = (event: TestKeyEvent) => tui.emitKeypress(event, { trackPropagation: true });

describe("useAppGlobalShortcuts", () => {
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

  test("U restarts into a downloaded desktop update, and does nothing for a terminal one", async () => {
    let restarts = 0;
    const config = createDefaultConfig("/tmp/gloomberb-global-shortcuts-restart");
    const desktopReady = { ...createInitialState(config), updateProgress: { phase: "ready" as const, canRestart: true } };
    await renderHarness(desktopReady, createRegistry(), () => {}, { restartToApplyUpdate: () => { restarts += 1; } });

    const restart = await emitKeypress({ name: "u" });
    expect(restarts).toBe(1);
    expect(restart.defaultPrevented).toBe(true);

    // The terminal binary is swapped in already: nothing to press.
    const terminalReady = { ...createInitialState(config), updateProgress: { phase: "ready" as const } };
    await renderHarness(terminalReady, createRegistry(), () => {}, { restartToApplyUpdate: () => { restarts += 1; } });
    const ignored = await emitKeypress({ name: "u" });
    expect(restarts).toBe(1);
    expect(ignored.defaultPrevented).toBe(false);
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

  function baseState(options: Partial<AppState> = {}): AppState {
    return { ...createInitialState(createDefaultConfig("/tmp/gloomberb-global-shortcuts")), ...options };
  }

  function layoutState(options: Partial<AppState> = {}): AppState {
    const config = createDefaultConfig("/tmp/gloomberb-global-shortcuts-layouts");
    config.layouts = [
      { name: "One", layout: cloneLayout(config.layout) },
      { name: "Two", layout: cloneLayout(config.layout) },
      { name: "Three", layout: cloneLayout(config.layout) },
    ];
    config.activeLayoutIndex = 0;
    return { ...createInitialState(config), ...options };
  }

  function stateWithTicker(): AppState {
    const state = baseState();
    state.tickers.set("AAPL", {
      metadata: { ticker: "AAPL", exchange: "NASDAQ" },
    } as any);
    return state;
  }

  interface SingleKeyCase {
    name: string;
    state?: () => AppState;
    editorFocused?: boolean;
    key: TestKeyEvent;
    actions?: AppAction[];
    openedPanes?: string[];
    /** Whether the shortcut layer claims the key (default prevented and propagation stopped). */
    consumed: boolean;
  }

  const singleKeyCases: SingleKeyCase[] = [
    {
      name: "toggles the command bar with Ctrl-P",
      key: { name: "p", ctrl: true },
      actions: [{ type: "TOGGLE_COMMAND_BAR" }],
      consumed: true,
    },
    {
      name: "toggles the command bar with Ctrl-K",
      key: { name: "k", ctrl: true },
      actions: [{ type: "TOGGLE_COMMAND_BAR" }],
      consumed: true,
    },
    {
      name: "opens ticker search with backtick",
      key: { name: "`" },
      actions: [{ type: "SET_COMMAND_BAR", open: true, query: "", launch: { kind: "ticker-search", query: "" } }],
      consumed: true,
    },
    {
      name: "switches saved layouts with Ctrl-number",
      state: () => layoutState(),
      key: { name: "2", ctrl: true },
      actions: [{ type: "SWITCH_LAYOUT", index: 1 }],
      consumed: true,
    },
    // Browsers and the desktop webview report Cmd as meta; the OpenTUI host maps
    // the kitty `super` modifier onto the same field.
    {
      name: "switches saved layouts with the Cmd-number reported by web and kitty hosts",
      state: () => layoutState(),
      key: { name: "3", super: true },
      actions: [{ type: "SWITCH_LAYOUT", index: 2 }],
      consumed: true,
    },
    // Alt-digit keeps its terminal meaning; only the primary modifier switches.
    { name: "ignores Alt-number", state: () => layoutState(), key: { name: "2", alt: true }, consumed: false },
    // Leaving the digit unclaimed lets the desktop webview treat Cmd-digit as its
    // own browser tab shortcut, which navigates the app away.
    {
      name: "consumes layout numbers while the command bar is open without switching",
      state: () => layoutState({ commandBarOpen: true }),
      key: { name: "2", ctrl: true },
      consumed: true,
    },
    {
      name: "consumes primary-modifier numbers with only one layout",
      state: () => baseState({ commandBarOpen: true }),
      key: { name: "1", super: true },
      consumed: true,
    },
    {
      name: "consumes layout numbers while an editable field owns the keyboard",
      state: () => layoutState(),
      editorFocused: true,
      key: { name: "2", super: true },
      consumed: true,
    },
    {
      name: "does not run plain plugin shortcuts while input is captured",
      state: () => baseState({ inputCaptured: true }),
      key: { name: "x" },
      consumed: false,
    },
    {
      name: "opens Help with question mark after the command bar is closed",
      key: { name: "?", shift: true },
      openedPanes: ["help"],
      consumed: true,
    },
    {
      name: "does not open Help with question mark while using the command bar",
      state: () => baseState({ commandBarOpen: true }),
      key: { name: "?", shift: true },
      consumed: false,
    },
    {
      name: "does not open Help with question mark while typing",
      state: () => baseState({ inputCaptured: true }),
      key: { name: "?", shift: true },
      consumed: false,
    },
    {
      name: "cycles panes with Tab while input is captured",
      state: () => baseState({ inputCaptured: true }),
      key: { name: "tab" },
      actions: [{ type: "FOCUS_NEXT", paneOrder: ["portfolio-list:main", "chat:main", "ticker-detail:main"] }],
      consumed: true,
    },
    {
      name: "does not treat modified Shift-R as force refresh",
      state: stateWithTicker,
      key: { name: "r", ctrl: true, shift: true },
      consumed: false,
    },
  ];

  test.each(singleKeyCases)("$name", async (testCase) => {
    const actions: AppAction[] = [];
    const openedPanes: string[] = [];
    // Plugin shortcut runs and ticker refreshes; no single-key case expects either.
    const sideEffects: string[] = [];
    await renderHarness(
      testCase.state?.() ?? baseState(),
      createRegistry(() => sideEffects.push("plugin-shortcut"), (paneId) => openedPanes.push(paneId)),
      (action) => actions.push(action),
      { refreshTicker: (symbol) => sideEffects.push(`refresh:${symbol}`) },
    );
    if (testCase.editorFocused) focusEditor();

    const event = await emitKeypress(testCase.key);

    expect(actions).toEqual(testCase.actions ?? []);
    expect(openedPanes).toEqual(testCase.openedPanes ?? []);
    expect(sideEffects).toEqual([]);
    expect(event.defaultPrevented).toBe(testCase.consumed);
    expect(event.propagationStopped).toBe(testCase.consumed);
  });
});
