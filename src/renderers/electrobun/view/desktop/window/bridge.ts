import type { PaneRuntimeState } from "../../../../../core/state/app/state";
import type {
  DesktopDockPreviewState,
  DesktopSharedStateSnapshot,
  DesktopThemePreviewState,
  DesktopWindowBridge,
} from "../../../../../types/desktop-window";
import { backendRequest, getElectrobunBackendInitSnapshot, onDesktopDockPreview, onDesktopState, onDesktopThemePreview } from "../../backend-rpc";
import { detachedSnapshotKey, prepareDetachedSnapshot } from "./snapshot";

export function createDesktopWindowBridge(kind: "main" | "detached", paneId?: string): DesktopWindowBridge {
  const initialDesktopSnapshot = getElectrobunBackendInitSnapshot()?.desktopSnapshot ?? null;
  let lastDetachedSnapshotKey = kind === "detached" && paneId && initialDesktopSnapshot
    ? detachedSnapshotKey(initialDesktopSnapshot, paneId)
    : null;

  return {
    kind,
    paneId,
    syncMainState: kind === "main"
      ? async (snapshot: DesktopSharedStateSnapshot) => {
        await backendRequest("desktop.syncMainState", { snapshot });
      }
      : undefined,
    syncThemePreview: kind === "main"
      ? async (preview: DesktopThemePreviewState) => {
        await backendRequest("desktop.setThemePreview", { preview });
      }
      : undefined,
    replaceDetachedPaneState: kind === "detached"
      ? async (targetPaneId: string, paneState: PaneRuntimeState) => {
        await backendRequest("desktop.replaceDetachedPaneState", { paneId: targetPaneId, paneState });
      }
      : undefined,
    popOutPane: async (targetPaneId: string) => {
      await backendRequest("desktop.popOutPane", { paneId: targetPaneId });
    },
    dockDetachedPane: async (targetPaneId: string) => {
      await backendRequest("desktop.dockDetachedPane", { paneId: targetPaneId });
    },
    closeDetachedPane: async (targetPaneId: string) => {
      await backendRequest("desktop.closeDetachedPane", { paneId: targetPaneId });
    },
    focusDetachedPane: async (targetPaneId: string) => {
      await backendRequest("desktop.focusDetachedPane", { paneId: targetPaneId });
    },
    subscribeState(listener: (snapshot: DesktopSharedStateSnapshot) => void) {
      return onDesktopState((message) => {
        if (kind === "detached" && paneId) {
          const nextKey = detachedSnapshotKey(message.snapshot, paneId);
          if (nextKey === lastDetachedSnapshotKey) return;
          lastDetachedSnapshotKey = nextKey;
          listener(prepareDetachedSnapshot(message.snapshot, paneId));
          return;
        }
        listener(message.snapshot);
      });
    },
    subscribeDockPreview(listener: (preview: DesktopDockPreviewState) => void) {
      return onDesktopDockPreview((message) => {
        listener(message.preview);
      });
    },
    subscribeThemePreview(listener: (preview: DesktopThemePreviewState) => void) {
      return onDesktopThemePreview((message) => {
        listener(message.preview);
      });
    },
  };
}
