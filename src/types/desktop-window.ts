import type { PaneRuntimeState } from "../core/state/app/state";
import type { AppConfig, SavedLayout } from "./config";

export interface DesktopSharedStateSnapshot {
  config: AppConfig;
  paneState: Record<string, PaneRuntimeState>;
  focusedPaneId: string | null;
  /** @deprecated Ignored and no longer sent. */
  activePanel?: "left" | "right";
  statusBarVisible: boolean;
  /** Transient position-sync failures, shared with detached Brokers panes. */
  brokerSyncErrors?: Record<string, string>;
  mainStateRevision?: number;
  layoutChanged?: boolean;
  /**
   * The tickers of panes in other windows that panes in this one follow, by
   * pane id: a link keeps working when the pane it follows moved away.
   */
  linkedTickers?: Record<string, string>;
  /**
   * The number of a state the desktop process sent. A window's next sync
   * names the one it last took, so only what it changed since counts.
   */
  stateSeq?: number;
}

/** A full desktop window, as the others list it to move a tab or a pane there. */
export interface DesktopWindowInfo {
  id: string;
  /** Its place in the order windows opened in: 1 for the main window. */
  number: number;
  /** The tab it shows. */
  activeLayoutName: string;
  tabCount: number;
}

/**
 * A tab another full window holds, at its place among all the tabs. The main
 * window's cloud sync pushes and pulls every window's tabs, not only its own.
 */
export interface OtherWindowTab {
  at: number;
  tab: SavedLayout;
}

/** Where a tab or pane goes: one of the open windows, or a new one. */
export type DesktopWindowTarget = { windowId: string } | { newWindow: true };

/**
 * The desktop app's full windows, for the window that holds this. Each has
 * its own tabs; a tab or a pane can move to another, and focus can follow.
 */
export interface DesktopWindowsBridge {
  /** This window's id. */
  readonly windowId: string;
  /** Every full window, this one included, in the order they opened. */
  list(): DesktopWindowInfo[];
  subscribe(listener: () => void): () => void;
  /** A new window on an empty tab of its own. */
  openWindow(): Promise<void>;
  /** Moves a tab of this window. Resolves false when it cannot go (this window's last tab, for the main window). */
  moveLayout(layoutId: string, target: DesktopWindowTarget): Promise<boolean>;
  movePane(paneId: string, target: DesktopWindowTarget): Promise<boolean>;
  focusWindow(windowId: string): Promise<void>;
  /** Brings forward the window showing a pane in another window, on the pane's tab, with the pane focused. */
  focusPane(paneId: string): Promise<boolean>;
  /** Asked by another window to focus one of this window's panes. */
  subscribeFocusRequests(listener: (paneId: string) => void): () => void;
  /**
   * The tabs the other windows hold, for cloud sync; the same array until
   * they change, which `subscribe` reports. Only the main window is sent
   * them, and only while there is more than one window.
   */
  otherWindowTabs(): readonly OtherWindowTab[];
}

export interface DesktopDockPreviewState {
  paneId: string | null;
  edge: "left" | "right" | "top" | "bottom" | null;
}

export interface DesktopThemePreviewState {
  theme: string | null;
}

export interface DesktopWindowBridge {
  kind: "main" | "detached";
  paneId?: string;
  /**
   * False in a full window other than the main one: it has its own tabs, but
   * the app-wide work (cloud sync, the session, the Dock badge, deep links,
   * remote control) stays with the main window.
   */
  primary?: boolean;
  /** The full windows, where the shell has more than one. */
  windows?: DesktopWindowsBridge;
  /** `baseSeq` is the `stateSeq` of the last state this window took, or null when it built on its own last sync. */
  syncMainState?(snapshot: DesktopSharedStateSnapshot, baseSeq?: number | null): Promise<void>;
  syncThemePreview?(preview: DesktopThemePreviewState): Promise<void>;
  replaceDetachedPaneState?(paneId: string, paneState: PaneRuntimeState): Promise<void>;
  popOutPane?(paneId: string): Promise<void>;
  dockDetachedPane?(paneId: string): Promise<void>;
  closeDetachedPane?(paneId: string): Promise<void>;
  focusDetachedPane?(paneId: string): Promise<void>;
  subscribeState(listener: (snapshot: DesktopSharedStateSnapshot) => void): () => void;
  subscribeDockPreview?(listener: (preview: DesktopDockPreviewState) => void): () => void;
  subscribeThemePreview?(listener: (preview: DesktopThemePreviewState) => void): () => void;
}
