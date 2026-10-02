import type {
  DesktopDockPreviewState,
  DesktopSharedStateSnapshot,
  DesktopThemePreviewState,
} from "../../../../types/desktop-window";
import { encodeRpcValue } from "../../shared/rpc-codec";

export interface DesktopStateRpc {
  send: {
    "desktop.state": (payload: { snapshot: DesktopSharedStateSnapshot }) => void;
    "desktop.dockPreview": (payload: { preview: DesktopDockPreviewState }) => void;
    "desktop.themePreview": (payload: { preview: DesktopThemePreviewState }) => void;
  };
}

interface DesktopStateBroadcasterOptions<Rpc extends DesktopStateRpc> {
  forEachReadyWindowRpc: (callback: (rpc: Rpc) => void) => void;
}

export class DesktopStateBroadcaster<Rpc extends DesktopStateRpc> {
  private dockPreview: DesktopDockPreviewState = { paneId: null, edge: null };
  private themePreview: DesktopThemePreviewState = { theme: null };

  constructor(private readonly options: DesktopStateBroadcasterOptions<Rpc>) {}

  get currentDockPreview(): DesktopDockPreviewState {
    return this.dockPreview;
  }

  get currentThemePreview(): DesktopThemePreviewState {
    return this.themePreview;
  }

  resetDockPreview(): void {
    this.dockPreview = { paneId: null, edge: null };
  }

  sendDesktopState(snapshot: DesktopSharedStateSnapshot | null): void {
    if (!snapshot) return;
    const encodedSnapshot = encodeRpcValue(snapshot) as DesktopSharedStateSnapshot;
    this.options.forEachReadyWindowRpc((rpc) => {
      rpc.send["desktop.state"]({
        snapshot: encodedSnapshot,
      });
    });
  }

  sendDockPreview(preview: DesktopDockPreviewState): void {
    if (this.dockPreview.paneId === preview.paneId && this.dockPreview.edge === preview.edge) {
      return;
    }
    this.dockPreview = preview;
    const encodedPreview = encodeRpcValue(preview) as DesktopDockPreviewState;
    this.options.forEachReadyWindowRpc((rpc) => {
      rpc.send["desktop.dockPreview"]({
        preview: encodedPreview,
      });
    });
  }

  sendThemePreview(preview: DesktopThemePreviewState): void {
    if (this.themePreview.theme === preview.theme) return;
    this.themePreview = preview;
    const encodedPreview = encodeRpcValue(preview) as DesktopThemePreviewState;
    this.options.forEachReadyWindowRpc((rpc) => {
      rpc.send["desktop.themePreview"]({
        preview: encodedPreview,
      });
    });
  }

  clearDockPreview(paneId?: string): void {
    if (paneId && this.dockPreview.paneId && this.dockPreview.paneId !== paneId) return;
    this.sendDockPreview({ paneId: null, edge: null });
  }
}
