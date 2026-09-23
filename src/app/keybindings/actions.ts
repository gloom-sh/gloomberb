/**
 * Every built-in action a key can be bound to, with the chords it ships with.
 * The ids are what `config.json` and the CLI use, so they read as actions, not
 * as the keys they happen to sit on today.
 */
export type CoreKeybindingActionId =
  | "command-bar"
  | "ticker-search"
  | "help"
  | "switch-layout"
  | "focus-next-pane"
  | "focus-prev-pane"
  | "refresh-ticker"
  | "refresh-all"
  | "install-update"
  | "notification-action"
  | "notification-dismiss"
  | "quit"
  | "pane-menu"
  | "pane-close"
  | "close-floating-panes"
  | "pane-settings"
  | "pane-fullscreen"
  | "pane-float"
  | "pane-pop-out"
  | "pane-screenshot"
  | "pane-export-csv"
  | "pane-share"
  | "layout-gallery"
  | "tidy-windows"
  | "window-move-mode"
  | "window-resize-mode";

export type KeybindingActionCategory = "Global Keys" | "Pane Management";

export interface KeybindingActionDef {
  id: CoreKeybindingActionId;
  category: KeybindingActionCategory;
  /** Help text. Kept in English here; the help pane translates it. */
  description: string;
  defaults: readonly string[];
  /** Only the desktop app has this action; the terminal hides the row. */
  desktopOnly?: boolean;
  /** Only the terminal has this action; the desktop app hides the row. */
  terminalOnly?: boolean;
}

export const PANE_ACTION_IDS = new Set<CoreKeybindingActionId>([
  "pane-menu",
  "pane-close",
  "close-floating-panes",
  "pane-settings",
  "pane-fullscreen",
  "pane-float",
  "pane-pop-out",
  "pane-screenshot",
  "pane-export-csv",
  "pane-share",
  "layout-gallery",
  "tidy-windows",
  "window-move-mode",
  "window-resize-mode",
]);

/**
 * Order matters twice: it is the order the help pane lists rows in, and the
 * order chords are matched in when two actions share one.
 */
export const KEYBINDING_ACTIONS: readonly KeybindingActionDef[] = [
  {
    id: "command-bar",
    category: "Global Keys",
    description: "Open the command bar.",
    defaults: ["Ctrl+P", "CmdOrCtrl+K"],
  },
  {
    id: "ticker-search",
    category: "Global Keys",
    description: "Open ticker search directly.",
    // One chord on purpose: the command bar already searches symbols for
    // free text, so a layout without a backtick key still has Ctrl+P and
    // typing. A dedicated key is a rebind away for anyone who wants one.
    defaults: ["`"],
  },
  {
    id: "help",
    category: "Global Keys",
    description: "Open help.",
    defaults: ["?"],
  },
  {
    id: "switch-layout",
    category: "Global Keys",
    description: "Switch saved layouts by number.",
    defaults: ["CmdOrCtrl+Digit"],
  },
  {
    id: "focus-next-pane",
    category: "Global Keys",
    description: "Move focus to the next pane or floating window.",
    defaults: ["Tab"],
  },
  {
    id: "focus-prev-pane",
    category: "Global Keys",
    description: "Move focus to the previous pane or floating window.",
    defaults: ["Shift+Tab"],
  },
  {
    id: "refresh-ticker",
    category: "Global Keys",
    description: "Refresh the focused ticker.",
    defaults: ["R"],
  },
  {
    id: "refresh-all",
    category: "Global Keys",
    description: "Refresh everything.",
    defaults: ["Shift+R"],
  },
  {
    id: "install-update",
    category: "Global Keys",
    description: "Install an available app update when one is shown.",
    defaults: ["U"],
  },
  {
    id: "notification-action",
    category: "Global Keys",
    description: "Run the newest notification's action, such as Review or Revert.",
    // Alt+Enter reaches every terminal; the desktop app advertises its own.
    defaults: ["Alt+Enter", "CmdOrCtrl+Shift+Enter"],
  },
  {
    id: "notification-dismiss",
    category: "Global Keys",
    description: "Dismiss the newest notification.",
    defaults: ["Alt+Backspace", "CmdOrCtrl+Shift+Backspace"],
  },
  {
    id: "quit",
    category: "Global Keys",
    description: "Quit the terminal app.",
    defaults: ["Q"],
    // The desktop app quits from its menu (Cmd+Q, Alt+F4); a bare letter
    // there would close the window on a stray keystroke.
    terminalOnly: true,
  },
  {
    id: "pane-menu",
    category: "Pane Management",
    description: "Open the focused pane's menu: settings, toggles, layout and window actions.",
    // "." stands for the pane's "..." button. Shift+F10 and the Menu key are
    // the platform keys for a context menu, and this is the pane's.
    defaults: [".", "Shift+F10", "ContextMenu"],
  },
  {
    id: "pane-close",
    category: "Pane Management",
    description: "Close the focused pane, docked or floating. Locked panes stay open.",
    defaults: ["CmdOrCtrl+W"],
  },
  {
    id: "close-floating-panes",
    category: "Pane Management",
    description: "Close all floating panes except locked ones.",
    defaults: ["CmdOrCtrl+Alt+W"],
  },
  {
    id: "pane-settings",
    category: "Pane Management",
    description: "Edit settings for the focused pane.",
    defaults: ["CmdOrCtrl+,"],
  },
  {
    id: "pane-fullscreen",
    category: "Pane Management",
    description: "Fill the window with the focused pane, or restore it.",
    defaults: ["CmdOrCtrl+Shift+F"],
  },
  {
    id: "pane-float",
    category: "Pane Management",
    description: "Dock or float the focused pane.",
    defaults: ["CmdOrCtrl+Shift+D"],
  },
  {
    id: "pane-pop-out",
    category: "Pane Management",
    description: "Pop the focused pane out to a desktop window.",
    defaults: ["CmdOrCtrl+Shift+O"],
    desktopOnly: true,
  },
  {
    id: "pane-screenshot",
    category: "Pane Management",
    description: "Copy a screenshot of the focused pane.",
    defaults: ["CmdOrCtrl+Shift+C"],
    desktopOnly: true,
  },
  {
    id: "pane-export-csv",
    category: "Pane Management",
    description: "Export the focused pane's table as CSV.",
    defaults: ["CmdOrCtrl+Shift+E"],
  },
  {
    id: "pane-share",
    category: "Pane Management",
    description: "Share the focused pane.",
    defaults: ["CmdOrCtrl+Shift+S"],
  },
  {
    id: "layout-gallery",
    category: "Pane Management",
    description: "Open layout actions.",
    defaults: ["CmdOrCtrl+Shift+L"],
  },
  {
    id: "tidy-windows",
    category: "Pane Management",
    description: "Tidy Windows",
    defaults: ["CmdOrCtrl+Shift+G"],
  },
  {
    id: "window-move-mode",
    category: "Pane Management",
    description: "Enter window move mode.",
    defaults: ["CmdOrCtrl+Shift+M"],
  },
  {
    id: "window-resize-mode",
    category: "Pane Management",
    description: "Enter window resize mode.",
    defaults: ["CmdOrCtrl+Shift+R"],
  },
];

const ACTION_BY_ID = new Map(KEYBINDING_ACTIONS.map((action) => [action.id, action]));

export function getKeybindingAction(id: string): KeybindingActionDef | undefined {
  return ACTION_BY_ID.get(id as CoreKeybindingActionId);
}

export function isCoreKeybindingActionId(id: string): id is CoreKeybindingActionId {
  return ACTION_BY_ID.has(id as CoreKeybindingActionId);
}

export const PLUGIN_ACTION_PREFIX = "plugin:";

export function pluginShortcutActionId(shortcutId: string): string {
  return `${PLUGIN_ACTION_PREFIX}${shortcutId}`;
}
