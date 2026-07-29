import type { DesktopWindowControlAction } from "../../shared/protocol";

export type { DesktopWindowControlAction } from "../../shared/protocol";

interface DesktopWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ControllableDesktopWindow {
  frame?: Partial<DesktopWindowFrame> | null;
  close?: () => void;
  minimize?: () => void;
  maximize?: () => void;
  unmaximize?: () => void;
  getFrame?: () => Partial<DesktopWindowFrame> | null;
  setFrame?: (x: number, y: number, width: number, height: number) => void;
}

const maximizedWindowRestoreFrames = new WeakMap<ControllableDesktopWindow, DesktopWindowFrame | null>();

function normalizeFrame(frame: Partial<DesktopWindowFrame> | null | undefined): DesktopWindowFrame | null {
  if (!frame) return null;
  const { x, y, width, height } = frame;
  if (
    typeof x !== "number"
    || typeof y !== "number"
    || typeof width !== "number"
    || typeof height !== "number"
    || !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(width)
    || !Number.isFinite(height)
  ) {
    return null;
  }
  return { x, y, width, height };
}

function readWindowFrame(window: ControllableDesktopWindow): DesktopWindowFrame | null {
  return normalizeFrame(window.getFrame?.() ?? window.frame);
}

function restoreWindowFrame(window: ControllableDesktopWindow, frame: DesktopWindowFrame | null): void {
  if (!frame) return;
  window.setFrame?.(frame.x, frame.y, frame.width, frame.height);
}

export function applyDesktopWindowControl(
  window: ControllableDesktopWindow,
  action: DesktopWindowControlAction,
): void {
  if (action === "close") {
    maximizedWindowRestoreFrames.delete(window);
    window.close?.();
    return;
  }

  if (action === "minimize") {
    window.minimize?.();
    return;
  }

  const restoreFrame = maximizedWindowRestoreFrames.get(window);
  if (maximizedWindowRestoreFrames.has(window)) {
    maximizedWindowRestoreFrames.delete(window);
    window.unmaximize?.();
    restoreWindowFrame(window, restoreFrame ?? null);
    return;
  }
  maximizedWindowRestoreFrames.set(window, readWindowFrame(window));
  window.maximize?.();
}
