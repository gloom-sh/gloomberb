import type { BrowserWindow } from "electrobun/bun";
import type { NativeWindowEvent } from "../../../desktop/window-host";
import { MAIN_WINDOW_ID } from "../../../desktop/screen-setup";
import { findPaneInstance } from "../../../../types/config";
import { isPaneDetached } from "../../../../layout/pane-manager";
import {
  DEFAULT_WINDOW_FRAME,
  DETACHED_WINDOW_MIN_SIZE,
  normalizeWindowFrameWithMinimum,
  type WindowFrame,
} from "../window/frame";
import { detachedRpcKey, paneIdFromDetachedRpcKey } from "../window/focus";
import type { DesktopBackend } from "./backend";

const INITIAL_DOCK_SUPPRESSION_MS = 800;
const WINDOW_CONTROL_DOCK_SUPPRESSION_MS = 5_000;
/** How long after the main window has its data the popped-out windows of the last session open. */
const LAUNCH_WINDOWS_DELAY_MS = 300;

/**
 * The windows that hold one popped-out pane each, opened and moved through
 * the window host like every other window. Their frames live in the config's
 * layout, which is how they reopen where they were.
 */
export class DesktopDetachedWindowManager {
  /** The panes with a window open. */
  private readonly windows = new Set<string>();
  private readonly frameTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dockTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingMoveFlush = new Set<string>();
  private readonly suppressDockUntil = new Map<string, number>();
  private readonly windowControlDockSuppressed = new Set<string>();
  /**
   * At launch, popped-out windows wait for the main window. Opening a window
   * holds this process until the system has made it (on Windows, its
   * browser too), and the main window's `init` used to wait behind each one.
   */
  private windowsAllowed = false;
  private windowsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly backend: DesktopBackend) {}

  /**
   * The main window has its data: the popped-out windows open shortly
   * after, once it has had a moment to draw and ask for what it shows, and
   * then `onOpen` runs (the extra full windows open there).
   */
  openAfterMainWindow(onOpen?: () => void): void {
    if (this.windowsAllowed || this.windowsTimer) return;
    this.windowsTimer = setTimeout(() => {
      this.windowsTimer = null;
      this.windowsAllowed = true;
      this.reconcile();
      onOpen?.();
    }, LAUNCH_WINDOWS_DELAY_MS);
  }

  focusDetachedPane(instanceId: string): boolean {
    return this.backend.focusWindow(detachedRpcKey(instanceId));
  }

  getWindowForRpcKey(rpcKey: string | undefined): BrowserWindow | null {
    const paneId = paneIdFromDetachedRpcKey(rpcKey);
    return paneId && this.windows.has(paneId) ? this.backend.windowHost?.browserWindow(rpcKey!) ?? null : null;
  }

  /** A popped-out pane's window moved or closed. */
  handleWindowEvent(event: NativeWindowEvent): void {
    const instanceId = paneIdFromDetachedRpcKey(event.id);
    // A window this side closed says nothing (the host only reports the
    // person's closes), and its state went with the close.
    if (!instanceId || !this.windows.has(instanceId)) return;
    if (event.type === "frame") {
      this.scheduleMove(instanceId);
      return;
    }
    if (event.type !== "close") return;
    this.cleanupState(instanceId);
    const workspace = this.backend.workspace;
    const config = this.backend.config;
    if (!workspace || !config || !isPaneDetached(config.layout, instanceId)) return;
    void this.backend.commitDesktopSnapshot(workspace.closeDetachedPane(instanceId));
  }

  private frameOf(rpcKey: string): WindowFrame | null {
    return this.backend.windowHost?.getWindowState(rpcKey)?.frame ?? null;
  }

  suppressAutoDockForRpcKey(rpcKey: string | undefined): void {
    const paneId = paneIdFromDetachedRpcKey(rpcKey);
    if (!paneId || !this.windows.has(paneId)) return;
    this.windowControlDockSuppressed.add(paneId);
    this.suppressDockUntil.set(paneId, Date.now() + WINDOW_CONTROL_DOCK_SUPPRESSION_MS);
    this.backend.stateBroadcaster.clearDockPreview(paneId);
  }

  resolveFrame(instanceId: string): WindowFrame {
    const detachedEntry = this.backend.requireConfig().layout.detached.find((entry) => entry.instanceId === instanceId);
    if (detachedEntry) {
      return normalizeWindowFrameWithMinimum(detachedEntry, DEFAULT_WINDOW_FRAME, DETACHED_WINDOW_MIN_SIZE);
    }
    const remembered = findPaneInstance(this.backend.requireConfig().layout, instanceId)?.placementMemory?.detached;
    if (remembered) {
      return normalizeWindowFrameWithMinimum(remembered, DEFAULT_WINDOW_FRAME, DETACHED_WINDOW_MIN_SIZE);
    }
    const mainFrame = this.frameOf(MAIN_WINDOW_ID) ?? DEFAULT_WINDOW_FRAME;
    return normalizeWindowFrameWithMinimum({
      x: mainFrame.x + 72,
      y: mainFrame.y + 72,
      width: Math.max(720, Math.floor(mainFrame.width * 0.45)),
      height: Math.max(420, Math.floor(mainFrame.height * 0.5)),
    }, DEFAULT_WINDOW_FRAME, DETACHED_WINDOW_MIN_SIZE);
  }

  reconcile(): void {
    const config = this.backend.config;
    if (!config) return;

    // A pane whose plugin is switched off stays in the layout, out of sight,
    // as it does in the main window: its window closes without undocking or
    // removing it, and opens again where it was when the plugin is back on.
    const disabledPlugins = new Set(config.disabledPlugins);
    const hidden = (instanceId: string) => {
      const paneType = findPaneInstance(config.layout, instanceId)?.paneId;
      const owner = paneType ? this.backend.paneOwners.get(paneType) : undefined;
      return !!owner && disabledPlugins.has(owner);
    };
    const desiredEntries = new Map(config.layout.detached
      .filter((entry) => !hidden(entry.instanceId))
      .map((entry) => [entry.instanceId, entry] as const));
    const host = this.backend.windowHost;
    for (const [instanceId, entry] of desiredEntries) {
      if (!this.windows.has(instanceId)) {
        if (this.windowsAllowed) this.createWindow(instanceId, entry);
        continue;
      }

      const key = detachedRpcKey(instanceId);
      const currentFrame = this.frameOf(key);
      const hasLiveFrameUpdate = this.pendingMoveFlush.has(instanceId)
        || this.frameTimers.has(instanceId)
        || this.dockTimers.has(instanceId);
      const nextFrame = currentFrame
        ? normalizeWindowFrameWithMinimum(entry, currentFrame, DETACHED_WINDOW_MIN_SIZE)
        : null;
      if (!hasLiveFrameUpdate
        && currentFrame
        && nextFrame
        && (currentFrame.x !== nextFrame.x
          || currentFrame.y !== nextFrame.y
          || currentFrame.width !== nextFrame.width
          || currentFrame.height !== nextFrame.height)) {
        host?.setFrame(key, nextFrame);
      }
      host?.setTitle(key, this.resolveTitle(instanceId));
    }

    for (const instanceId of [...this.windows]) {
      if (desiredEntries.has(instanceId)) continue;
      this.closePaneWindow(instanceId);
    }
  }

  closeAll(): void {
    for (const instanceId of [...this.windows]) this.closePaneWindow(instanceId);
    this.backend.stateBroadcaster.resetDockPreview();
  }

  private closePaneWindow(instanceId: string): void {
    this.cleanupState(instanceId);
    this.backend.windowHost?.closeWindow(detachedRpcKey(instanceId));
  }

  private resolveTitle(instanceId: string): string {
    const config = this.backend.config;
    const instance = config ? findPaneInstance(config.layout, instanceId) : null;
    if (!instance) return "Gloom";
    return instance.title?.trim() || instance.paneId;
  }

  private resolveDockEdge(frame: WindowFrame): "left" | "right" | "top" | "bottom" | null {
    const mainFrame = this.frameOf(MAIN_WINDOW_ID);
    if (!mainFrame) return null;
    const threshold = 72;
    const headerMidX = frame.x + (frame.width / 2);
    const headerMidY = frame.y + 16;
    const overlapsVertically = headerMidY >= mainFrame.y - 32 && headerMidY <= mainFrame.y + mainFrame.height + 32;
    const overlapsHorizontally = headerMidX >= mainFrame.x - 32 && headerMidX <= mainFrame.x + mainFrame.width + 32;

    if (overlapsVertically && Math.abs(headerMidX - mainFrame.x) <= threshold) return "left";
    if (overlapsVertically && Math.abs(headerMidX - (mainFrame.x + mainFrame.width)) <= threshold) return "right";
    if (overlapsHorizontally && Math.abs(headerMidY - mainFrame.y) <= threshold) return "top";
    if (overlapsHorizontally && Math.abs(headerMidY - (mainFrame.y + mainFrame.height)) <= threshold) return "bottom";
    return null;
  }

  private cleanupState(instanceId: string): void {
    this.backend.disposeWindowResources(detachedRpcKey(instanceId));
    this.windows.delete(instanceId);
    this.clearTimer(this.frameTimers, instanceId);
    this.clearTimer(this.dockTimers, instanceId);
    this.pendingMoveFlush.delete(instanceId);
    this.suppressDockUntil.delete(instanceId);
    this.windowControlDockSuppressed.delete(instanceId);
    this.backend.rpcs.unregisterWindowRpc(detachedRpcKey(instanceId));
  }

  private createWindow(
    instanceId: string,
    frame: Partial<WindowFrame>,
  ): void {
    const host = this.backend.windowHost;
    if (!host) return;
    this.windows.add(instanceId);
    this.suppressDockUntil.set(instanceId, Date.now() + INITIAL_DOCK_SUPPRESSION_MS);
    host.openWindow({
      id: detachedRpcKey(instanceId),
      kind: "pane",
      title: this.resolveTitle(instanceId),
      frame: normalizeWindowFrameWithMinimum(frame, DEFAULT_WINDOW_FRAME, DETACHED_WINDOW_MIN_SIZE),
      minSize: DETACHED_WINDOW_MIN_SIZE,
    });
  }

  private scheduleMove(instanceId: string): void {
    if (this.pendingMoveFlush.has(instanceId)) return;
    this.pendingMoveFlush.add(instanceId);
    setTimeout(() => {
      this.pendingMoveFlush.delete(instanceId);
      this.handleMove(instanceId);
    }, 0);
  }

  private handleMove(instanceId: string): void {
    const workspace = this.backend.workspace;
    const config = this.backend.config;
    if (!this.windows.has(instanceId) || !workspace || !config || !isPaneDetached(config.layout, instanceId)) {
      return;
    }

    const frame = this.frameOf(detachedRpcKey(instanceId));
    if (!frame) return;
    const edge = this.resolveDockEdge(frame);

    this.clearTimer(this.frameTimers, instanceId);
    this.frameTimers.set(instanceId, setTimeout(() => {
      this.frameTimers.delete(instanceId);
      const nextConfig = this.backend.config;
      const nextWorkspace = this.backend.workspace;
      if (!nextConfig || !nextWorkspace || !isPaneDetached(nextConfig.layout, instanceId)) return;
      void this.backend.commitDesktopSnapshot(
        this.backend.requireWorkspace().updateDetachedFrame(instanceId, frame),
        { reconcileWindows: false },
      );
    }, 120));

    this.clearTimer(this.dockTimers, instanceId);
    if (this.windowControlDockSuppressed.has(instanceId)) {
      this.backend.stateBroadcaster.clearDockPreview(instanceId);
      if (!edge) {
        this.windowControlDockSuppressed.delete(instanceId);
      }
      return;
    }

    const suppressDockUntil = this.suppressDockUntil.get(instanceId) ?? 0;
    if (Date.now() < suppressDockUntil) {
      this.backend.stateBroadcaster.clearDockPreview(instanceId);
      return;
    }
    this.suppressDockUntil.delete(instanceId);

    if (!edge) {
      this.backend.stateBroadcaster.clearDockPreview(instanceId);
      return;
    }

    this.backend.stateBroadcaster.sendDockPreview({ paneId: instanceId, edge });
    this.dockTimers.set(instanceId, setTimeout(() => {
      this.dockTimers.delete(instanceId);
      const nextConfig = this.backend.config;
      const nextWorkspace = this.backend.workspace;
      if (!nextConfig || !nextWorkspace || !isPaneDetached(nextConfig.layout, instanceId)) return;
      if (
        this.backend.stateBroadcaster.currentDockPreview.paneId !== instanceId
        || this.backend.stateBroadcaster.currentDockPreview.edge !== edge
      ) return;
      this.backend.stateBroadcaster.clearDockPreview(instanceId);
      void this.backend.commitDesktopSnapshot(this.backend.requireWorkspace().dockDetachedPane(instanceId, edge));
    }, 120));
  }

  private clearTimer(
    timers: Map<string, ReturnType<typeof setTimeout>>,
    key: string,
  ): void {
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.delete(key);
    }
  }
}
