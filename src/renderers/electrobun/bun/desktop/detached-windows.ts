import type { BrowserWindow } from "electrobun/bun";
import { findPaneInstance } from "../../../../types/config";
import { isPaneDetached } from "../../../../layout/pane-manager";
import {
  DEFAULT_WINDOW_FRAME,
  DETACHED_WINDOW_MIN_SIZE,
  normalizeWindowFrameWithMinimum,
  type WindowFrame,
} from "../window/frame";
import {
  detachedRpcKey,
  focusWindowForRpcKey,
  paneIdFromDetachedRpcKey,
} from "../window/focus";
import { getWindowFrame } from "../window/events";
import { createAppWindow } from "../window/create";
import type { DesktopBackend } from "./backend";

const INITIAL_DOCK_SUPPRESSION_MS = 800;
const WINDOW_CONTROL_DOCK_SUPPRESSION_MS = 5_000;

export class DesktopDetachedWindowManager {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly frameTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dockTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly closingPanes = new Set<string>();
  private readonly pendingMoveFlush = new Set<string>();
  private readonly suppressDockUntil = new Map<string, number>();
  private readonly windowControlDockSuppressed = new Set<string>();

  constructor(private readonly backend: DesktopBackend) {}

  focusDetachedPane(instanceId: string): boolean {
    return this.focusWindowForRpcKey(detachedRpcKey(instanceId));
  }

  focusWindowForRpcKey(rpcKey: string | undefined): boolean {
    return focusWindowForRpcKey(rpcKey, this.backend.mainWindow, this.windows);
  }

  getWindowForRpcKey(rpcKey: string | undefined): BrowserWindow | null {
    const paneId = paneIdFromDetachedRpcKey(rpcKey);
    return paneId ? this.windows.get(paneId) ?? null : null;
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
    const mainFrame = getWindowFrame(this.backend.mainWindow) ?? DEFAULT_WINDOW_FRAME;
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
    for (const [instanceId, entry] of desiredEntries) {
      const existingWindow = this.windows.get(instanceId);
      if (!existingWindow) {
        this.createWindow(instanceId, entry);
        continue;
      }

      const currentFrame = getWindowFrame(existingWindow);
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
        existingWindow.setFrame(nextFrame.x, nextFrame.y, nextFrame.width, nextFrame.height);
      }
      (existingWindow as any).setTitle?.(this.resolveTitle(instanceId));
    }

    for (const [instanceId, window] of this.windows) {
      if (desiredEntries.has(instanceId)) continue;
      this.closingPanes.add(instanceId);
      this.cleanupState(instanceId);
      (window as any).close?.();
    }
  }

  closeAll(): void {
    for (const [instanceId, window] of this.windows) {
      this.closingPanes.add(instanceId);
      this.cleanupState(instanceId);
      (window as any).close?.();
    }
    this.backend.stateBroadcaster.resetDockPreview();
  }

  private resolveTitle(instanceId: string): string {
    const config = this.backend.config;
    const instance = config ? findPaneInstance(config.layout, instanceId) : null;
    if (!instance) return "Gloomberb";
    return instance.title?.trim() || instance.paneId;
  }

  private resolveDockEdge(frame: WindowFrame): "left" | "right" | "top" | "bottom" | null {
    const mainFrame = getWindowFrame(this.backend.mainWindow);
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
  ): BrowserWindow {
    const rpc = this.backend.createWindowRpc(detachedRpcKey(instanceId));
    const initialFrame = normalizeWindowFrameWithMinimum(frame, DEFAULT_WINDOW_FRAME, DETACHED_WINDOW_MIN_SIZE);
    const title = this.resolveTitle(instanceId);
    const window = createAppWindow({
      title,
      frame: initialFrame,
      rpc: rpc as never,
      minSize: DETACHED_WINDOW_MIN_SIZE,
      onFrameChange: () => this.scheduleMove(instanceId),
    });
    this.windows.set(instanceId, window);
    this.suppressDockUntil.set(instanceId, Date.now() + INITIAL_DOCK_SUPPRESSION_MS);

    (window as any).on?.("close", () => {
      const shouldIgnore = this.closingPanes.delete(instanceId);
      this.cleanupState(instanceId);
      const workspace = this.backend.workspace;
      const config = this.backend.config;
      if (shouldIgnore || !workspace || !config || !isPaneDetached(config.layout, instanceId)) {
        return;
      }
      void this.backend.commitDesktopSnapshot(this.backend.requireWorkspace().closeDetachedPane(instanceId));
    });

    return window;
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
    const window = this.windows.get(instanceId);
    const workspace = this.backend.workspace;
    const config = this.backend.config;
    if (!window || !workspace || !config || !isPaneDetached(config.layout, instanceId)) {
      return;
    }

    const frame = getWindowFrame(window);
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
