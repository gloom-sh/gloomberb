import type { KeyEventLike } from "../../../react/input";
import {
  advertisedChord,
  getDefaultKeybindings,
  isPaneKeybindingAction,
  matchKeybinding,
  menuAcceleratorFor,
  serializeKeyChord,
  type CoreKeybindingActionId,
  type ResolvedKeybindings,
} from "../../../app/keybindings";
import type { ShortcutDisplayMode } from "../../../utils/shortcut-labels";

export type PaneManagementShortcut =
  | "menu"
  | "settings"
  | "toggle-fullscreen"
  | "new-layout"
  | "toggle-floating"
  | "pop-out"
  | "copy-screenshot"
  | "export-csv"
  | "share"
  | "ask"
  | "close"
  | "close-all-floating"
  | "layout-gallery"
  | "gridlock-all"
  | "window-mode"
  | "window-resize-mode";

const PANE_ACTION_TO_SHORTCUT: Partial<Record<CoreKeybindingActionId, PaneManagementShortcut>> = {
  "pane-menu": "menu",
  "pane-settings": "settings",
  "pane-fullscreen": "toggle-fullscreen",
  "pane-new-layout": "new-layout",
  "pane-float": "toggle-floating",
  "pane-pop-out": "pop-out",
  "pane-screenshot": "copy-screenshot",
  "pane-export-csv": "export-csv",
  "pane-share": "share",
  "pane-ask": "ask",
  "pane-close": "close",
  "close-floating-panes": "close-all-floating",
  "layout-gallery": "layout-gallery",
  "tidy-windows": "gridlock-all",
  "window-move-mode": "window-mode",
  "window-resize-mode": "window-resize-mode",
};

export type PaneManagementAccelerators = Record<
  "menu" | "settings" | "fullscreen" | "newLayout" | "toggleFloating" | "popOut" | "copyScreenshot" | "exportCsv" | "share" | "ask" | "close"
  | "closeAllFloating" | "layoutGallery" | "gridlockAll" | "windowMode" | "windowResizeMode" | "tickerSearch",
  string | undefined
>;

/**
 * Menu accelerators for the pane actions, read from the same table the keys
 * are. A native menu only takes chords on the platform modifier; the terminal
 * menu shows Ask Gloom on the chord a terminal delivers (Alt+A), not on
 * Ctrl+Shift+A, which many terminals keep for themselves.
 */
export function paneManagementAccelerators(
  keybindings: ResolvedKeybindings,
  mode: ShortcutDisplayMode = "platform",
): PaneManagementAccelerators {
  const terminalAsk = mode === "terminal" ? advertisedChord(keybindings, "pane-ask", "terminal") : null;
  // The backtick has no modifier, so it is said as the terminal advertises it.
  const tickerSearch = advertisedChord(keybindings, "ticker-search", mode);
  return {
    menu: menuAcceleratorFor(keybindings, "pane-menu"),
    settings: menuAcceleratorFor(keybindings, "pane-settings"),
    fullscreen: menuAcceleratorFor(keybindings, "pane-fullscreen"),
    newLayout: menuAcceleratorFor(keybindings, "pane-new-layout"),
    toggleFloating: menuAcceleratorFor(keybindings, "pane-float"),
    popOut: menuAcceleratorFor(keybindings, "pane-pop-out"),
    copyScreenshot: menuAcceleratorFor(keybindings, "pane-screenshot"),
    exportCsv: menuAcceleratorFor(keybindings, "pane-export-csv"),
    share: menuAcceleratorFor(keybindings, "pane-share"),
    ask: terminalAsk ? serializeKeyChord(terminalAsk) : menuAcceleratorFor(keybindings, "pane-ask"),
    close: menuAcceleratorFor(keybindings, "pane-close"),
    closeAllFloating: menuAcceleratorFor(keybindings, "close-floating-panes"),
    layoutGallery: menuAcceleratorFor(keybindings, "layout-gallery"),
    gridlockAll: menuAcceleratorFor(keybindings, "tidy-windows"),
    windowMode: menuAcceleratorFor(keybindings, "window-move-mode"),
    windowResizeMode: menuAcceleratorFor(keybindings, "window-resize-mode"),
    tickerSearch: tickerSearch ? serializeKeyChord(tickerSearch) : undefined,
  };
}

export const PANE_MANAGEMENT_ACCELERATORS = paneManagementAccelerators(getDefaultKeybindings());

export function resolvePaneManagementShortcut(
  event: Pick<KeyEventLike, "name" | "key" | "ctrl" | "meta" | "super" | "shift" | "alt">,
  keybindings: ResolvedKeybindings = getDefaultKeybindings(),
): PaneManagementShortcut | null {
  const match = matchKeybinding(keybindings, event);
  if (!match || match.kind !== "action" || !isPaneKeybindingAction(match.id)) return null;
  return PANE_ACTION_TO_SHORTCUT[match.id as CoreKeybindingActionId] ?? null;
}

/**
 * Whether a modal surface (the pane menu, window mode) keeps a key from the
 * app behind it: every unmodified key, and a modified chord only when it is one
 * of the app's own bindings, so platform chords (Cmd+Q, copy) still work.
 */
export function modalSurfaceOwnsKey(
  event: Pick<KeyEventLike, "name" | "key" | "ctrl" | "meta" | "super" | "shift" | "alt">,
  keybindings: ResolvedKeybindings = getDefaultKeybindings(),
): boolean {
  if (!event.ctrl && !event.meta && !event.super && !event.alt) return true;
  return matchKeybinding(keybindings, event) !== null;
}

export function inputCaptureAllowsPaneManagementShortcut(
  shortcut: PaneManagementShortcut,
  event: Pick<KeyEventLike, "ctrl" | "meta" | "super" | "targetEditable">,
): boolean {
  // A screenshot does not edit the field that captured input. Keep it available
  // from composers (ASKG, chat, etc.) on both desktop modifier layouts.
  if (shortcut === "copy-screenshot") return event.ctrl || event.meta || event.super === true;
  // Command chords are never text. Alt+A and Ctrl+Shift+A edit a terminal
  // field (line start), so a field that has the keyboard keeps them there.
  if (shortcut === "toggle-fullscreen" || shortcut === "new-layout" || shortcut === "ask") return event.meta || event.super === true;
  if (shortcut !== "close" && shortcut !== "close-all-floating") return false;
  return event.meta || event.super || event.targetEditable !== true;
}
