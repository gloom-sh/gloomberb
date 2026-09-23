import { useEffect, useRef } from "react";
import { useShortcut } from "../../../../react/input";
import { useKeybindings } from "../../../../app/keybindings";
import type { WindowEditMode } from "../../../../plugins/registry";
import {
  armDoubleEscapeClose,
  createDoubleEscapeCloseState,
  resetDoubleEscapeClose,
  takeDoubleEscapeClose,
} from "../../../../utils/double-escape-close";
import {
  inputCaptureAllowsPaneManagementShortcut,
  resolvePaneManagementShortcut,
} from "../shortcuts";

interface ShellPaneManagementShortcutOptions {
  cancelActiveDrag(): void;
  closeAllFloatingPanes(): boolean;
  closeFocusedPane(): boolean;
  copyFocusedPaneScreenshot(): boolean;
  exportFocusedPaneCsv(): boolean;
  focusedPaneId: string | null;
  gridlockVisiblePanes(): boolean;
  hasActiveDrag(): boolean;
  inputCaptured: boolean;
  openFocusedPaneMenu(): boolean;
  openFocusedPaneSettings(): boolean;
  openLayoutGallery(): void;
  overlayOpen: boolean;
  popOutFocusedPane(): boolean;
  shareFocusedPane(): boolean;
  startWindowMode(paneId?: string, mode?: WindowEditMode): void;
  toggleFocusedPaneFullscreen(): boolean;
  toggleFocusedPaneFloating(): boolean;
}

export function useShellPaneManagementShortcuts({
  cancelActiveDrag,
  closeAllFloatingPanes,
  closeFocusedPane,
  copyFocusedPaneScreenshot,
  exportFocusedPaneCsv,
  focusedPaneId,
  gridlockVisiblePanes,
  hasActiveDrag,
  inputCaptured,
  openFocusedPaneMenu,
  openFocusedPaneSettings,
  openLayoutGallery,
  overlayOpen,
  popOutFocusedPane,
  shareFocusedPane,
  startWindowMode,
  toggleFocusedPaneFullscreen,
  toggleFocusedPaneFloating,
}: ShellPaneManagementShortcutOptions): void {
  const doubleEscapeCloseRef = useRef(createDoubleEscapeCloseState());
  const keybindings = useKeybindings();

  useEffect(() => {
    if (overlayOpen) {
      resetDoubleEscapeClose(doubleEscapeCloseRef.current);
    }
  }, [overlayOpen]);

  useShortcut((event) => {
    const shortcut = resolvePaneManagementShortcut(event, keybindings);
    if (shortcut === "toggle-fullscreen" && !overlayOpen) {
      if (!inputCaptured || inputCaptureAllowsPaneManagementShortcut(shortcut, event)) {
        if (hasActiveDrag()) {
          cancelActiveDrag();
        }
        if (toggleFocusedPaneFullscreen()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }

    const isEscape = event.name === "escape" || event.name === "esc";
    if (isEscape) {
      const doubleEscapeState = doubleEscapeCloseRef.current;
      if (!hasActiveDrag() && !overlayOpen) {
        if (takeDoubleEscapeClose(doubleEscapeState, focusedPaneId, Date.now()) && closeFocusedPane()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      } else {
        resetDoubleEscapeClose(doubleEscapeState);
      }

      if (!hasActiveDrag()) return;
      cancelActiveDrag();
      event.preventDefault();
      event.stopPropagation();
    } else {
      resetDoubleEscapeClose(doubleEscapeCloseRef.current);
    }
  }, { phase: "before" });

  // Only an Esc nothing else used arms the close, including a footer's Esc
  // hint: the idle phase runs last and never sees a key a handler consumed.
  useShortcut((event) => {
    if (event.name !== "escape" && event.name !== "esc") return;
    if (hasActiveDrag() || overlayOpen) return;
    armDoubleEscapeClose(doubleEscapeCloseRef.current, focusedPaneId, Date.now());
  }, { phase: "idle" });

  // The pane menu key is a fallback too: a pane that binds "." keeps it,
  // however late it mounted.
  useShortcut((event) => {
    if (resolvePaneManagementShortcut(event, keybindings) !== "menu") return;
    if (hasActiveDrag() || overlayOpen || inputCaptured) return;
    if (!openFocusedPaneMenu()) return;
    event.preventDefault();
    event.stopPropagation();
  }, { phase: "idle" });

  useShortcut((event) => {
    const shortcut = resolvePaneManagementShortcut(event, keybindings);
    if (!shortcut || hasActiveDrag() || overlayOpen) return;
    if (inputCaptured && !inputCaptureAllowsPaneManagementShortcut(shortcut, event)) return;
    if (shortcut === "menu") return;

    let handled = false;
    switch (shortcut) {
      case "close":
        handled = closeFocusedPane();
        break;
      case "close-all-floating":
        handled = closeAllFloatingPanes();
        break;
      case "settings":
        handled = openFocusedPaneSettings();
        break;
      case "toggle-fullscreen":
        handled = toggleFocusedPaneFullscreen();
        break;
      case "toggle-floating":
        handled = toggleFocusedPaneFloating();
        break;
      case "pop-out":
        handled = popOutFocusedPane();
        break;
      case "copy-screenshot":
        handled = copyFocusedPaneScreenshot();
        break;
      case "export-csv":
        handled = exportFocusedPaneCsv();
        break;
      case "share":
        handled = shareFocusedPane();
        break;
      case "layout-gallery":
        openLayoutGallery();
        handled = true;
        break;
      case "gridlock-all":
        handled = gridlockVisiblePanes();
        break;
      case "window-mode":
        startWindowMode(undefined, "move");
        handled = true;
        break;
      case "window-resize-mode":
        startWindowMode(undefined, "resize");
        handled = true;
        break;
    }

    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  });
}
