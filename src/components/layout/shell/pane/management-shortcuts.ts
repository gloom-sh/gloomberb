import { useEffect, useRef } from "react";
import { useShortcut } from "../../../../react/input";
import type { WindowEditMode } from "../../../../plugins/registry";
import {
  createDoubleEscapeCloseState,
  recordDoubleEscapeClose,
  resetDoubleEscapeClose,
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
  focusedPaneId: string | null;
  gridlockVisiblePanes(): boolean;
  hasActiveDrag(): boolean;
  inputCaptured: boolean;
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
  focusedPaneId,
  gridlockVisiblePanes,
  hasActiveDrag,
  inputCaptured,
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

  useEffect(() => {
    if (overlayOpen) {
      resetDoubleEscapeClose(doubleEscapeCloseRef.current);
    }
  }, [overlayOpen]);

  useShortcut((event) => {
    const shortcut = resolvePaneManagementShortcut(event);
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
        if (recordDoubleEscapeClose(doubleEscapeState, focusedPaneId, Date.now()) && closeFocusedPane()) {
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

  useShortcut((event) => {
    const shortcut = resolvePaneManagementShortcut(event);
    if (!shortcut || hasActiveDrag() || overlayOpen) return;
    if (inputCaptured && !inputCaptureAllowsPaneManagementShortcut(shortcut, event)) return;

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
