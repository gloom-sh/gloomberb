export type DesktopApplicationMenuCommand =
  | { type: "open-command-bar"; query?: string }
  | { type: "open-plugin-workflow"; commandId: string }
  | { type: "open-url"; url: string }
  | { type: "check-for-updates" }
  | { type: "toggle-status-bar" }
  | { type: "open-layout-gallery" }
  | { type: "layout-undo" }
  | { type: "layout-redo" }
  | { type: "layout-gridlock" };

export interface DesktopApplicationMenuBridge {
  subscribe(listener: (command: DesktopApplicationMenuCommand) => void): () => void;
}
