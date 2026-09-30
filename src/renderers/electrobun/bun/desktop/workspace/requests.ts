import type { DesktopWorkspaceRequest } from "../../../shared/protocol";
import type { DesktopBackend } from "../backend";

type DockEdge = "left" | "right" | "top" | "bottom";

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

export async function handleDesktopWorkspaceRequest(
  backend: DesktopBackend,
  request: DesktopWorkspaceRequest,
): Promise<null> {
  const workspace = backend.requireWorkspace();
  const { detachedWindows, stateBroadcaster } = backend;
  switch (request.method) {
    case "desktop.syncMainState": {
      const snapshot = workspace.syncMainState(request.payload.snapshot);
      backend.setConfig(snapshot.config);
      detachedWindows.reconcile();
      stateBroadcaster.sendDesktopState(snapshot);
      return null;
    }
    case "desktop.setThemePreview":
      stateBroadcaster.sendThemePreview(request.payload.preview ?? { theme: null });
      return null;
    case "desktop.replaceDetachedPaneState": {
      const paneId = requirePaneId(request.payload, request.method);
      stateBroadcaster.sendDesktopState(workspace.replaceDetachedPaneState(paneId, request.payload.paneState));
      return null;
    }
    case "desktop.popOutPane": {
      const paneId = requirePaneId(request.payload, request.method);
      const snapshot = workspace.popOutPane(paneId, detachedWindows.resolveFrame(paneId));
      await backend.commitDesktopSnapshot(snapshot);
      detachedWindows.focusDetachedPane(paneId);
      return null;
    }
    case "desktop.dockDetachedPane": {
      const paneId = requirePaneId(request.payload, request.method);
      stateBroadcaster.clearDockPreview(paneId);
      await backend.commitDesktopSnapshot(workspace.dockDetachedPane(paneId, normalizeDockEdge(request.payload.edge)));
      return null;
    }
    case "desktop.closeDetachedPane": {
      const paneId = requirePaneId(request.payload, request.method);
      stateBroadcaster.clearDockPreview(paneId);
      await backend.commitDesktopSnapshot(workspace.closeDetachedPane(paneId));
      return null;
    }
    case "desktop.focusDetachedPane": {
      const paneId = requirePaneId(request.payload, request.method);
      detachedWindows.focusDetachedPane(paneId);
      return null;
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown desktop method: ${String(exhaustive)}`);
    }
  }
}
