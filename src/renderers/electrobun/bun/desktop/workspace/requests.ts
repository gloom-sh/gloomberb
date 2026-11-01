import type { DesktopWorkspaceRequest } from "../../../shared/protocol";
import { MAIN_WINDOW_RPC_KEY } from "../../window/focus";
import type { DesktopBackend, DesktopRpc } from "../backend";

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
  rpc: DesktopRpc,
  request: DesktopWorkspaceRequest,
): Promise<null | boolean> {
  const workspace = backend.requireWorkspace();
  const { detachedWindows, stateBroadcaster } = backend;
  switch (request.method) {
    case "desktop.syncMainState": {
      // Any full window sends its whole state; a popped-out pane's never does.
      const windowId = backend.fullWindowKey(rpc);
      if (!windowId) return null;
      const snapshot = workspace.syncWindowState(windowId, request.payload.snapshot, request.payload.baseSeq);
      backend.setConfig(snapshot.config);
      backend.reconcileWindows();
      // The window holds what it sent. It gets the state back only when this
      // process changed it: another window's edit, a popped-out window's
      // frame, a stale revision.
      stateBroadcaster.noteWindowState(rpc, request.payload.snapshot);
      stateBroadcaster.sendDesktopState(snapshot);
      return null;
    }
    case "desktop.setThemePreview":
      stateBroadcaster.sendThemePreview(request.payload.preview ?? { theme: null }, rpc);
      return null;
    case "desktop.replaceDetachedPaneState": {
      const paneId = requirePaneId(request.payload, request.method);
      stateBroadcaster.sendDesktopState(workspace.replaceDetachedPaneState(paneId, request.payload.paneState));
      return null;
    }
    case "desktop.popOutPane": {
      const paneId = requirePaneId(request.payload, request.method);
      // Popped-out panes belong to the main window's tab; elsewhere a pane moves to a window instead.
      if (backend.fullWindowKey(rpc) !== MAIN_WINDOW_RPC_KEY) return null;
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
    case "desktop.openWindow":
      await backend.openExtraWindow();
      return null;
    case "desktop.moveLayoutToWindow": {
      const { layoutId, windowId } = request.payload;
      if (typeof layoutId !== "string") throw new Error(`${request.method} requires layoutId.`);
      if (windowId === null) return (await backend.openExtraWindow({ layoutId })) !== null;
      const snapshot = workspace.moveLayoutToWindow(layoutId, windowId);
      if (!snapshot) return false;
      await backend.commitDesktopSnapshot(snapshot);
      backend.windowController?.focus(windowId);
      return true;
    }
    case "desktop.movePaneToWindow": {
      const paneId = requirePaneId(request.payload, request.method);
      const target = request.payload.windowId;
      // A new window opens holding the pane, or not at all.
      if (target == null) return (await backend.openExtraWindow({ paneId })) !== null;
      const snapshot = workspace.movePaneToWindow(paneId, target);
      if (!snapshot) return false;
      await backend.commitDesktopSnapshot(snapshot);
      backend.windowController?.focus(target);
      return true;
    }
    case "desktop.focusWindow":
      backend.windowController?.focus(String(request.payload.windowId));
      return null;
    case "desktop.focusPane": {
      const paneId = requirePaneId(request.payload, request.method);
      return backend.focusPaneAnywhere(paneId);
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown desktop method: ${String(exhaustive)}`);
    }
  }
}
