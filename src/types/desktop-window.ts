import type { PaneRuntimeState } from "../core/state/app/state";
import type { AppConfig, LayoutConfig } from "./config";

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

export type DesktopLayoutMarketplaceAction =
  | { type: "SWITCH_LAYOUT"; index: number }
  | { type: "NEW_LAYOUT"; name: string }
  | { type: "INSTALL_LAYOUT_COPY"; name: string; layout: LayoutConfig }
  | { type: "DELETE_LAYOUT"; index: number }
  | { type: "RENAME_LAYOUT"; index: number; name: string }
  | { type: "DUPLICATE_LAYOUT"; index: number };

export interface DesktopWindowBridge {
  kind: "main" | "detached" | "marketplace";
  paneId?: string;
  openLayoutMarketplace?(): Promise<void>;
  performLayoutMarketplaceAction?(action: DesktopLayoutMarketplaceAction): Promise<void>;
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
