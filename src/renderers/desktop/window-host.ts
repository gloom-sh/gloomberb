import type { DesktopDisplay, Rect } from "./geometry";

/**
 * Everything the desktop app asks of its shell about windows and screens.
 * The window state, its persistence and folding windows onto the screens
 * that remain (window-controller.ts, window-layouts.ts) only go through
 * this, so moving to another shell means writing one of these for it.
 */

export interface WindowSize {
  width: number;
  height: number;
}

export interface NativeWindowState {
  /** The window's frame now; while maximized or full screen, the maximized frame. */
  frame: Rect;
  maximized: boolean;
  fullscreen: boolean;
  minimized: boolean;
}

/** `app` is a full window with its own tabs; `pane` holds one popped-out pane. */
type NativeWindowKind = "app" | "pane";

export interface OpenWindowSpec {
  id: string;
  kind: NativeWindowKind;
  title: string;
  frame: Rect;
  minSize: WindowSize;
}

export type NativeWindowEvent =
  /** Moved or resized, by the person, the system, or a frame this side set. */
  | { type: "frame"; id: string }
  | { type: "focus"; id: string }
  /** Closed from outside: its close button, the system. Not sent for `closeWindow`. */
  | { type: "close"; id: string }
  /** Minimized or brought back. A window on another Space or fully covered is reported by its page, not here. */
  | { type: "visibility"; id: string; visible: boolean };

export interface DesktopWindowHost {
  /**
   * Whether the shell lets a window choose where it opens and move itself.
   * A Wayland compositor places windows on its own, so a saved position
   * cannot be restored there; sizes and maximized still are.
   */
  readonly canPlaceWindows: boolean;
  /** Whether a window can go full screen from here. */
  readonly canFullscreen: boolean;
  listDisplays(): DesktopDisplay[];
  openWindow(spec: OpenWindowSpec): void;
  closeWindow(id: string): void;
  hasWindow(id: string): boolean;
  /**
   * Where a window is and how it is shown. While its `close` event is being
   * delivered, a window closed from outside still answers, with what was
   * last known of it, so where it was last moved can be saved.
   */
  getWindowState(id: string): NativeWindowState | null;
  setFrame(id: string, frame: Rect): void;
  setMaximized(id: string, maximized: boolean): void;
  setFullscreen(id: string, fullscreen: boolean): void;
  setTitle(id: string, title: string): void;
  focusWindow(id: string): void;
  /** Called when the displays change: one plugged in or out, moved, or rescaled. */
  onDisplaysChanged(listener: (displays: DesktopDisplay[]) => void): () => void;
  onWindowEvent(listener: (event: NativeWindowEvent) => void): () => void;
}
