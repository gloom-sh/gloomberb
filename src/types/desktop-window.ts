import type { PaneRuntimeState } from "../core/state/app/state";
import type { AppConfig } from "./config";

export interface DesktopSharedStateSnapshot {
  config: AppConfig;
  paneState: Record<string, PaneRuntimeState>;
  focusedPaneId: string | null;
  activePanel: "left" | "right";
  statusBarVisible: boolean;
  mainStateRevision?: number;
  layoutChanged?: boolean;
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
  syncMainState?(snapshot: DesktopSharedStateSnapshot): Promise<void>;
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
