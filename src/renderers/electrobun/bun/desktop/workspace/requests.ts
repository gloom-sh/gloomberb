import type {
  DesktopSharedStateSnapshot,
  DesktopThemePreviewState,
} from "../../../../../types/desktop-window";
import type { DesktopWorkspaceRequest } from "../../../shared/protocol";
import type { DesktopWorkspace } from "./index";
import type { WindowFrame } from "../../window/frame";

type DockEdge = "left" | "right" | "top" | "bottom";

interface DesktopWorkspaceRequestOptions {
  workspace: DesktopWorkspace;
  request: DesktopWorkspaceRequest;
  setCurrentConfig: (config: DesktopSharedStateSnapshot["config"]) => void;
  sendThemePreview: (preview: DesktopThemePreviewState) => void;
  clearDockPreview: (paneId?: string) => void;
  sendDesktopState: (snapshot: DesktopSharedStateSnapshot) => void;
  reconcileDetachedWindows: () => void;
  commitDesktopSnapshot: (
    snapshot: DesktopSharedStateSnapshot,
    options?: { persistConfig?: boolean; reconcileWindows?: boolean },
  ) => Promise<DesktopSharedStateSnapshot>;
  resolveDetachedFrame: (paneId: string) => WindowFrame;
  focusDetachedPane: (paneId: string) => void;
}

function requirePaneId(payload: { paneId: string }, method: string): string {
  if (typeof payload.paneId !== "string") {
    throw new Error(`${method} requires paneId.`);
  }
  return payload.paneId;
}

function normalizeDockEdge(edge: unknown): DockEdge | undefined {
  return edge === "left" || edge === "right" || edge === "top" || edge === "bottom"
    ? edge
    : undefined;
}

export async function handleDesktopWorkspaceRequest({
  workspace,
  request,
  setCurrentConfig,
  sendThemePreview,
  clearDockPreview,
  sendDesktopState,
  reconcileDetachedWindows,
  commitDesktopSnapshot,
  resolveDetachedFrame,
  focusDetachedPane,
}: DesktopWorkspaceRequestOptions): Promise<null> {
  switch (request.method) {
    case "desktop.syncMainState": {
      const snapshot = workspace.syncMainState(request.payload.snapshot);
      setCurrentConfig(snapshot.config);
      reconcileDetachedWindows();
      sendDesktopState(snapshot);
      return null;
    }
    case "desktop.setThemePreview":
      sendThemePreview(request.payload.preview ?? { theme: null });
      return null;
    case "desktop.replaceDetachedPaneState": {
      const paneId = requirePaneId(request.payload, request.method);
      sendDesktopState(workspace.replaceDetachedPaneState(paneId, request.payload.paneState));
      return null;
    }
    case "desktop.popOutPane": {
      const paneId = requirePaneId(request.payload, request.method);
      const snapshot = workspace.popOutPane(paneId, resolveDetachedFrame(paneId));
      await commitDesktopSnapshot(snapshot);
      focusDetachedPane(paneId);
      return null;
    }
    case "desktop.dockDetachedPane": {
      const paneId = requirePaneId(request.payload, request.method);
      clearDockPreview(paneId);
      await commitDesktopSnapshot(workspace.dockDetachedPane(paneId, normalizeDockEdge(request.payload.edge)));
      return null;
    }
    case "desktop.closeDetachedPane": {
      const paneId = requirePaneId(request.payload, request.method);
      clearDockPreview(paneId);
      await commitDesktopSnapshot(workspace.closeDetachedPane(paneId));
      return null;
    }
    case "desktop.focusDetachedPane": {
      const paneId = requirePaneId(request.payload, request.method);
      focusDetachedPane(paneId);
      return null;
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown desktop method: ${String(exhaustive)}`);
    }
  }
}
