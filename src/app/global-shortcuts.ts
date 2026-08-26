import type { Dispatch } from "react";
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

export function useAppGlobalShortcuts({
  dispatch,
  focusedTickerSymbol,
  isDetachedWindow,
  pluginRegistry,
  refreshTicker,
  startUpdate,
  state,
}: {
  dispatch: Dispatch<AppAction>;
  focusedTickerSymbol: string | null;
  isDetachedWindow: boolean;
  pluginRegistry: PluginRegistry;
  refreshTicker: (symbol: string, exchange?: string, tickerOverride?: TickerRecord | null, priority?: number) => void;
  startUpdate: (release: ReleaseInfo) => void;
  state: AppState;
}) {
  const dialogOpen = useDialogState((s) => s.isOpen);
  const nativeRenderer = useNativeRenderer();
  const rendererHost = useRendererHost();

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

    // Terminals send Ctrl; the browser and the desktop webview send Cmd on
    // macOS, which the OpenTUI host also reports as `super` under the kitty
    // protocol. Alt stays out so Alt-digit keeps its terminal meaning. While a
    // dialog, the command bar or an editable field owns the keyboard the digit
    // must not move layouts, but it still has to be swallowed there or the
    // webview hands Cmd-digit to the browser's own tab switcher.
    if (!isDetachedWindow
      && /^[1-9]$/.test(event.name ?? "")
      && (event.ctrl || event.meta || event.super)) {
      const layouts = state.config.layouts ?? [];
      const idx = parseInt(event.name!, 10) - 1;
      // The gallery's own search field must not swallow layout switching, so an
      // editable target only blocks the digit outside the gallery.
      const uiOwnsKeyboard = dialogOpen
        || state.commandBarOpen
        || (event.targetEditable === true && !state.layoutMarketplaceOpen);
      if (!uiOwnsKeyboard && idx < layouts.length) {
        if (idx !== state.config.activeLayoutIndex) {
          dispatch({ type: "SWITCH_LAYOUT", index: idx });
        }
        if (state.layoutMarketplaceOpen) {
          dispatch({ type: "SET_LAYOUT_MARKETPLACE", open: false });
        }
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (dialogOpen) return;

    // The gallery replaces the workspace, so workspace keys stay inert until it closes.
    if (state.layoutMarketplaceOpen) return;

    if (!isDetachedWindow && (
      (event.name === "p" && event.ctrl)
      || (event.name === "k" && (event.ctrl || event.meta || event.super))
    )) {
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "TOGGLE_COMMAND_BAR" });
      return;
    }
    if (!isDetachedWindow && event.name === "`" && !state.commandBarOpen) {
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

    const hasShortcutModifier = event.ctrl || event.meta || event.super || event.alt;

    if (state.commandBarOpen) return;

    if (event.name === "tab") {
      const paneOrder = getVisiblePaneCycleOrder(
        state.config.layout,
        pluginRegistry,
        state.config.disabledPlugins,
      );
      if (paneOrder.length === 0) return;

      if (event.shift) {
        dispatch({ type: "FOCUS_PREV", paneOrder });
      } else {
        dispatch({ type: "FOCUS_NEXT", paneOrder });
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (state.inputCaptured) return;

    const isQuestionMark = event.name === "?"
      || event.key === "?"
      || event.sequence === "?"
      || (event.name === "/" && event.shift);
    if (!isDetachedWindow && !hasShortcutModifier && isQuestionMark) {
      event.preventDefault();
      event.stopPropagation();
      pluginRegistry.showPane("help");
      return;
    }

    if (!hasShortcutModifier && !isDetachedWindow && event.name === "q") {
      rendererHost.requestExit();
    } else if (!hasShortcutModifier && event.name === "r") {
      if (focusedTickerSymbol) {
        const ticker = state.tickers.get(focusedTickerSymbol);
        if (ticker) refreshTicker(ticker.metadata.ticker, ticker.metadata.exchange, ticker, 0);
      }
    } else if (!hasShortcutModifier && (event.name === "R" || (event.name === "r" && event.shift))) {
      for (const ticker of state.tickers.values()) {
        refreshTicker(ticker.metadata.ticker, ticker.metadata.exchange, ticker, 1);
      }
    } else if (!hasShortcutModifier && event.name === "u" && state.updateAvailable && !state.updateProgress && !state.updateCheckInProgress && canSelfUpdate(state.updateAvailable)) {
      startUpdate(state.updateAvailable);
    } else {
      const disabledPlugins = new Set(state.config.disabledPlugins || []);
      for (const shortcut of pluginRegistry.shortcuts.values()) {
        const ownerId = pluginRegistry.getShortcutPluginId(shortcut.id);
        if (ownerId && disabledPlugins.has(ownerId)) continue;
        if (shortcut.key === event.name
            && (shortcut.ctrl ?? false) === (event.ctrl ?? false)
            && (shortcut.shift ?? false) === (event.shift ?? false)) {
          shortcut.execute();
          break;
        }
      }
    }
  }, { phase: "before" });
}
