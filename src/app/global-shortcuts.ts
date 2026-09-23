import { useEffect, useRef, type Dispatch } from "react";
import { useShortcut } from "../react/input";
import { useNativeRenderer, useRendererHost } from "../ui";
import { useDialogState } from "../ui/dialog";
import type { PluginRegistry } from "../plugins/registry";
import type { AppAction, AppState } from "../state/app/context";
import type { TickerRecord } from "../types/ticker";
import type { ReleaseInfo } from "../updater";
import { canSelfUpdate } from "../updater";
import { getVisiblePaneCycleOrder } from "../components/layout/pane/cycle-order";
import {
  copyActiveSelection,
  isCopyShortcut,
  isPasteShortcut,
  pasteSystemClipboard,
} from "../utils/selection-clipboard";
import {
  describeKeybindingIssue,
  getDefaultKeybindings,
  matchKeybinding,
  matchesKeyChord,
  requestKeybindingCapture,
  resolvePluginShortcutChords,
  type ResolvedKeybindings,
} from "./keybindings";

/** Long enough to read a few conflicts and choose Review. */
const KEYBINDING_NOTICE_DURATION_MS = 15_000;

/**
 * Tells the user once per launch when `config.json` holds a binding that does
 * not parse, names no action, or lands on a key another action already has.
 * Silence would read as "I set it and nothing happened".
 */
function useKeybindingIssueNotice(
  keybindings: ResolvedKeybindings,
  pluginRegistry: PluginRegistry,
  initialized: boolean,
) {
  const noticedRef = useRef<string | null>(null);
  const issueKey = keybindings.issues.map(describeKeybindingIssue).join("\n");
  useEffect(() => {
    if (!initialized || !issueKey || noticedRef.current === issueKey) return;
    noticedRef.current = issueKey;
    const lines = keybindings.issues.map(describeKeybindingIssue);
    const shown = lines.slice(0, 3);
    const more = lines.length - shown.length;
    pluginRegistry.notify({
      body: [
        "Keybindings need attention:",
        ...shown,
        ...(more > 0 ? [`and ${more} more; see Help > Shortcuts.`] : []),
      ].join("\n"),
      type: "error",
      duration: KEYBINDING_NOTICE_DURATION_MS,
      action: {
        label: "Review",
        onClick: () => {
          requestKeybindingCapture({ kind: "review" });
          pluginRegistry.showPane("help");
        },
      },
    });
  }, [initialized, issueKey, keybindings.issues, pluginRegistry]);
}

export function useAppGlobalShortcuts({
  dispatch,
  focusedTickerSymbol,
  isDetachedWindow,
  keybindings = getDefaultKeybindings(),
  pluginRegistry,
  refreshTicker,
  startUpdate,
  state,
}: {
  dispatch: Dispatch<AppAction>;
  focusedTickerSymbol: string | null;
  isDetachedWindow: boolean;
  /** The resolved table; the app resolves it once and shares it with the shell. */
  keybindings?: ResolvedKeybindings;
  pluginRegistry: PluginRegistry;
  refreshTicker: (symbol: string, exchange?: string, tickerOverride?: TickerRecord | null, priority?: number) => void;
  startUpdate: (release: ReleaseInfo) => void;
  state: AppState;
}) {
  const dialogOpen = useDialogState((s) => s.isOpen);
  const nativeRenderer = useNativeRenderer();
  const rendererHost = useRendererHost();
  useKeybindingIssueNotice(keybindings, pluginRegistry, state.initialized);

  useShortcut((event) => {
    if (isCopyShortcut(event) && copyActiveSelection(nativeRenderer)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isPasteShortcut(event) && pasteSystemClipboard(nativeRenderer)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const match = matchKeybinding(keybindings, event);
    const action = match?.kind === "action" ? match.id : null;

    // Terminals send Ctrl; the browser and the desktop webview send Cmd on
    // macOS, which the OpenTUI host also reports as `super` under the kitty
    // protocol. While a dialog, the command bar or an editable field owns the
    // keyboard the digit must not move layouts, but it still has to be
    // swallowed there or the webview hands Cmd-digit to the browser's own tab
    // switcher.
    if (!isDetachedWindow && action === "switch-layout" && match?.kind === "action" && match.digit !== null) {
      const layouts = state.config.layouts ?? [];
      const idx = match.digit - 1;
      const uiOwnsKeyboard = dialogOpen || state.commandBarOpen || event.targetEditable === true;
      if (!uiOwnsKeyboard && idx < layouts.length && idx !== state.config.activeLayoutIndex) {
        dispatch({ type: "SWITCH_LAYOUT", index: idx });
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (dialogOpen) return;

    if (!isDetachedWindow && action === "command-bar") {
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "TOGGLE_COMMAND_BAR" });
      return;
    }
    if (!isDetachedWindow && action === "ticker-search" && !state.commandBarOpen) {
      event.preventDefault();
      event.stopPropagation();
      dispatch({
        type: "SET_COMMAND_BAR",
        open: true,
        query: "",
        launch: { kind: "ticker-search", query: "" },
      });
      return;
    }

    if (state.commandBarOpen) return;

    if (action === "focus-next-pane" || action === "focus-prev-pane") {
      const paneOrder = getVisiblePaneCycleOrder(
        state.config.layout,
        pluginRegistry,
        state.config.disabledPlugins,
      );
      if (paneOrder.length === 0) return;

      dispatch({ type: action === "focus-prev-pane" ? "FOCUS_PREV" : "FOCUS_NEXT", paneOrder });
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (match?.kind === "command" && !isDetachedWindow) {
      // Control chords belong to the editor while text is being typed; Alt,
      // Command and function keys are never text, so they still fire.
      const editing = state.inputCaptured || event.targetEditable === true;
      if (editing && event.ctrl && !(event.meta || event.super)) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({
        type: "SET_COMMAND_BAR",
        open: true,
        query: match.command.query,
        launch: { kind: "run-query", query: match.command.query },
      });
      return;
    }

    if (state.inputCaptured) return;

    if (!isDetachedWindow && action === "help") {
      event.preventDefault();
      event.stopPropagation();
      pluginRegistry.showPane("help");
      return;
    }

    if (!isDetachedWindow && action === "quit") {
      rendererHost.requestExit();
    } else if (action === "refresh-ticker") {
      if (focusedTickerSymbol) {
        const ticker = state.tickers.get(focusedTickerSymbol);
        if (ticker) refreshTicker(ticker.metadata.ticker, ticker.metadata.exchange, ticker, 0);
      }
    } else if (action === "refresh-all") {
      for (const ticker of state.tickers.values()) {
        refreshTicker(ticker.metadata.ticker, ticker.metadata.exchange, ticker, 1);
      }
    } else if (action === "install-update") {
      if (state.updateAvailable && !state.updateProgress && !state.updateCheckInProgress && canSelfUpdate(state.updateAvailable)) {
        startUpdate(state.updateAvailable);
      }
    } else if (!action) {
      const disabledPlugins = new Set(state.config.disabledPlugins || []);
      const keybindingsConfig = state.config.keybindings;
      for (const shortcut of pluginRegistry.shortcuts.values()) {
        const ownerId = pluginRegistry.getShortcutPluginId(shortcut.id);
        if (ownerId && disabledPlugins.has(ownerId)) continue;
        const chords = resolvePluginShortcutChords(keybindingsConfig, shortcut);
        if (chords.some((chord) => matchesKeyChord(chord, event))) {
          shortcut.execute();
          break;
        }
      }
    }
  }, { phase: "before" });
}
