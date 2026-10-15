import { useEffect, useRef, useState, type Dispatch } from "react";
import { useShortcut } from "../react/input";
import { useNativeRenderer, useRendererHost, useUiHost } from "../ui";
import { useDialogState } from "../ui/dialog";
import { useToastHost } from "../ui/toast";
import type { PluginRegistry } from "../plugins/registry";
import type { AppAction, AppState } from "../state/app/context";
import type { TickerRecord } from "../types/ticker";
import { findPaneInstance } from "../types/config";
import type { ReleaseInfo } from "../updater";
import { canRestartToApply, canSelfUpdate } from "../updater";
import { getVisiblePaneCycleOrder } from "../components/layout/pane/cycle-order";
import { requestFunctionHelp, useFunctionHelpHost } from "../plugins/builtin/help/function-card";
import { buildRegistryHelpIndex, helpFunctionForPane } from "../plugins/builtin/help/function-index";
import { recordFunctionOpen } from "../telemetry/usage-counts";
import { createOneShots } from "../utils/one-shot";
import { DOCS_PANE_TEMPLATE_ID } from "../docs/content";
import { registerPaneDocsHandler } from "../docs/requests";
import { isMoveDownShortcut, isMoveUpShortcut } from "../components/command-bar/keyboard-handlers";
import { pressStarPromptKey } from "./star-prompt/runtime";
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
 * Whether the install-update key has something to retry: a release this build
 * can install itself whose last attempt failed. A fresh one downloads on its
 * own, and a manual or managed one names its own command. (A downloaded
 * desktop update has its own use of the key: restarting into it.)
 */
export function canRetryUpdate(
  state: Pick<AppState, "updateAvailable" | "updateProgress" | "updateCheckInProgress">,
): boolean {
  return !!state.updateAvailable
    && state.updateProgress?.phase === "error"
    && !state.updateCheckInProgress
    && canSelfUpdate(state.updateAvailable);
}

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
  restartToApplyUpdate,
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
  /** Applies a downloaded desktop update and relaunches. Runs only on the user's key press. */
  restartToApplyUpdate: () => void;
  startUpdate: (release: ReleaseInfo) => void;
  state: AppState;
}) {
  const dialogOpen = useDialogState((s) => s.isOpen);
  const nativeRenderer = useNativeRenderer();
  const rendererHost = useRendererHost();
  const uiKind = useUiHost().kind;
  const toastHost = useToastHost();
  useKeybindingIssueNotice(keybindings, pluginRegistry, state.initialized);
  // Every action here runs once per press: a held key, or a terminal that does
  // not say it is a repeat, must not run it again. Only moving focus between
  // panes (Tab) and switching layouts by number (idempotent) are left to repeat.
  const [shots] = useState(createOneShots);
  useFunctionHelpHost({
    closeCommandBar: () => {
      if (state.commandBarOpen) dispatch({ type: "SET_COMMAND_BAR", open: false });
    },
  });
  const layoutRef = useRef(state.config.layout);
  layoutRef.current = state.config.layout;
  // A pane's `?`: its entry in DOCS, or its help card where no pane can open.
  useEffect(() => registerPaneDocsHandler((paneId) => {
    if (!isDetachedWindow) {
      pluginRegistry.createPaneFromTemplate(DOCS_PANE_TEMPLATE_ID, { values: { pane: paneId } });
      return;
    }
    const instance = findPaneInstance(layoutRef.current, paneId);
    const fn = instance ? helpFunctionForPane(buildRegistryHelpIndex(pluginRegistry), pluginRegistry, instance) : null;
    if (fn) requestFunctionHelp({ kind: "function", fn, inAppDocs: false });
  }), [isDetachedWindow, pluginRegistry]);

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
    /**
     * Whether the action already ran for this press or hold. An action that
     * takes the key (`claims`) swallows the refused ones as well; one that
     * leaves it to the pane (R) does not, so a pane's own key keeps working.
     */
    const ranAlready = (id: string, claims = true): boolean => {
      const shot = shots.get(id);
      if (shot.refuses(event)) {
        if (claims) {
          event.preventDefault();
          event.stopPropagation();
        }
        return true;
      }
      shot.end();
      return false;
    };

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

    // Toasts float above everything, so their keys work over a dialog too.
    // The status bar's star line answers the same keys once no toast does,
    // but only over the workspace itself.
    if (action === "notification-action" || action === "notification-dismiss") {
      if (ranAlready(action)) return;
      const toastHandled = action === "notification-action"
        ? toastHost.activateNewest?.() === true
        : toastHost.dismissNewest?.() === true;
      const handled = toastHandled || (
        !dialogOpen
        && !state.commandBarOpen
        && !state.inputCaptured
        && !isDetachedWindow
        && pressStarPromptKey(action === "notification-action" ? "open" : "dismiss")
      );
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    // Text fields keep Cmd+Z. Everywhere else it restores the previous layout.
    // A detached window has no layout history of its own.
    if (action === "layout-undo" || action === "layout-redo") {
      if (isDetachedWindow || dialogOpen || state.commandBarOpen || state.inputCaptured || event.targetEditable === true) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: action === "layout-undo" ? "UNDO_LAYOUT" : "REDO_LAYOUT" });
      return;
    }

    if (dialogOpen) return;

    if (!isDetachedWindow && action === "command-bar") {
      // Ctrl+P and Ctrl+N move the open bar's selection, so a bar chord that
      // is one of them only opens it; Esc and the bar's other chords close it.
      if (state.commandBarOpen && (isMoveUpShortcut(event) || isMoveDownShortcut(event))) return;
      if (ranAlready(action)) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "TOGGLE_COMMAND_BAR" });
      return;
    }
    if (!isDetachedWindow && action === "ticker-search" && !state.commandBarOpen) {
      if (ranAlready(action)) return;
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
      if (ranAlready(`command:${match.command.query}`)) return;
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

    // A function key is never text, so the card opens from a focused field too.
    if (action === "function-help") {
      if (ranAlready(action)) return;
      event.preventDefault();
      event.stopPropagation();
      recordFunctionOpen({ shortcut: "HELP", externalPluginId: null });
      const instance = state.focusedPaneId ? findPaneInstance(state.config.layout, state.focusedPaneId) : undefined;
      const fn = instance ? helpFunctionForPane(buildRegistryHelpIndex(pluginRegistry), pluginRegistry, instance) : null;
      if (fn && requestFunctionHelp({ kind: "function", fn, inAppDocs: !isDetachedWindow })) return;
      if (!isDetachedWindow) pluginRegistry.showPane("help");
      return;
    }

    if (state.inputCaptured) return;

    if (!isDetachedWindow && action === "help") {
      if (ranAlready(action)) return;
      event.preventDefault();
      event.stopPropagation();
      pluginRegistry.showPane("help");
      return;
    }

    if (!isDetachedWindow && action === "quit") {
      if (ranAlready(action, false)) return;
      if (uiKind === "opentui") rendererHost.requestExit();
    } else if (action === "refresh-ticker") {
      if (ranAlready(action, false)) return;
      if (focusedTickerSymbol) {
        const ticker = state.tickers.get(focusedTickerSymbol);
        if (ticker) refreshTicker(ticker.metadata.ticker, ticker.metadata.exchange, ticker, 0);
      }
    } else if (action === "refresh-all") {
      if (ranAlready(action, false)) return;
      for (const ticker of state.tickers.values()) {
        refreshTicker(ticker.metadata.ticker, ticker.metadata.exchange, ticker, 1);
      }
    } else if (action === "install-update") {
      // A release that can install itself downloads on its own, so the key is
      // for the one that waits for a restart and for the one that failed.
      if (!isDetachedWindow && canRestartToApply(state.updateProgress)) {
        if (ranAlready(action)) return;
        event.preventDefault();
        event.stopPropagation();
        restartToApplyUpdate();
      } else if (canRetryUpdate(state)) {
        if (ranAlready(action)) return;
        event.preventDefault();
        event.stopPropagation();
        startUpdate(state.updateAvailable!);
      }
    } else if (!action) {
      const disabledPlugins = new Set(state.config.disabledPlugins || []);
      const keybindingsConfig = state.config.keybindings;
      for (const shortcut of pluginRegistry.shortcuts.values()) {
        const ownerId = pluginRegistry.getShortcutPluginId(shortcut.id);
        if (ownerId && disabledPlugins.has(ownerId)) continue;
        const chords = resolvePluginShortcutChords(keybindingsConfig, shortcut);
        if (chords.some((chord) => matchesKeyChord(chord, event))) {
          if (ranAlready(`plugin:${shortcut.id}`, false)) return;
          shortcut.execute();
          break;
        }
      }
    }
  }, { phase: "before" });
}
