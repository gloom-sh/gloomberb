import type { PaneRuntimeState } from "../../../../../core/state/app/state";
import type {
  DesktopDockPreviewState,
  DesktopSharedStateSnapshot,
  DesktopThemePreviewState,
  DesktopWindowBridge,
  DesktopWindowInfo,
  DesktopWindowsBridge,
  DesktopWindowTarget,
} from "../../../../../types/desktop-window";
import { backendRequest, getElectrobunBackendInitSnapshot, onBackendMessage } from "../../backend-rpc";
import { createDetachedSnapshotFilter } from "./snapshot";

const MAIN_WINDOW_ID = "main";

function targetWindowId(target: DesktopWindowTarget): string | null {
  return "windowId" in target ? target.windowId : null;
}

/** The full windows as the backend lists them, kept current by its `desktop.windows` messages. */
function createDesktopWindowsBridge(windowId: string, initial: DesktopWindowInfo[]): DesktopWindowsBridge {
  let windows = initial;
  const listeners = new Set<() => void>();
  onBackendMessage("desktop.windows", (message) => {
    windows = message.windows;
    for (const listener of listeners) listener();
  });
  return {
    windowId,
    list: () => windows,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async openWindow() {
      await backendRequest("desktop.openWindow", null);
    },
    moveLayout: (layoutId, target) => backendRequest("desktop.moveLayoutToWindow", { layoutId, windowId: targetWindowId(target) }),
    movePane: (paneId, target) => backendRequest("desktop.movePaneToWindow", { paneId, windowId: targetWindowId(target) }),
    async focusWindow(targetId) {
      await backendRequest("desktop.focusWindow", { windowId: targetId });
    },
    focusPane: (paneId) => backendRequest("desktop.focusPane", { paneId }),
    subscribeFocusRequests: (listener) => onBackendMessage("desktop.focusPane", (message) => listener(message.paneId)),
  };
}

export function createDesktopWindowBridge(kind: "main" | "detached", paneId?: string): DesktopWindowBridge {
  const init = getElectrobunBackendInitSnapshot();
  const initialDesktopSnapshot = init?.desktopSnapshot ?? null;
  const takeDetachedSnapshot = kind === "detached" && paneId
    ? createDetachedSnapshotFilter(paneId, initialDesktopSnapshot)
    : null;
  const windowId = kind === "main" ? init?.windowId ?? MAIN_WINDOW_ID : null;

  return {
    kind,
    paneId,
    primary: windowId === MAIN_WINDOW_ID,
    windows: windowId ? createDesktopWindowsBridge(windowId, init?.windows ?? []) : undefined,
    syncMainState: kind === "main"
      ? async (snapshot: DesktopSharedStateSnapshot, baseSeq?: number | null) => {
        await backendRequest("desktop.syncMainState", { snapshot, baseSeq });
      }
      : undefined,
    // The theme preview reaches every window from the one with Settings open.
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
      return onBackendMessage("desktop.state", (message) => {
        if (takeDetachedSnapshot) {
          const snapshot = takeDetachedSnapshot(message.snapshot);
          if (snapshot) listener(snapshot);
          return;
        }
        listener(message.snapshot);
      });
    },
    subscribeDockPreview(listener: (preview: DesktopDockPreviewState) => void) {
      return onBackendMessage("desktop.dockPreview", (message) => {
        listener(message.preview);
      });
    },
    subscribeThemePreview(listener: (preview: DesktopThemePreviewState) => void) {
      return onBackendMessage("desktop.themePreview", (message) => {
        listener(message.preview);
      });
    },
  };
}
