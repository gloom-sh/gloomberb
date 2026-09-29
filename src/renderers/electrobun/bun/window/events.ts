import type { BrowserWindow } from "electrobun/bun";
import {
  DEFAULT_WINDOW_FRAME,
  normalizeWindowFrame,
  normalizeWindowFrameWithMinimum,
  type WindowFrame,
  type WindowMinimumSize,
} from "./frame";

export type WindowMoveEvent = { data?: { x?: number; y?: number } };
export type WindowResizeEvent = { data?: Partial<WindowFrame> };

export function getWindowFrame(window: BrowserWindow | null): WindowFrame | null {
  if (!window) return null;
  return normalizeWindowFrame(window.frame);
}

export function updateWindowFrameCache(
  window: BrowserWindow | null,
  patch: Partial<WindowFrame>,
  minimumSize?: WindowMinimumSize,
): WindowFrame | null {
  if (!window) return null;
  const nextFrame = normalizeWindowFrameWithMinimum(patch, getWindowFrame(window) ?? DEFAULT_WINDOW_FRAME, minimumSize);
  window.frame = nextFrame;
  return nextFrame;
}

export function applyWindowMoveEvent(window: BrowserWindow | null, event: WindowMoveEvent): WindowFrame | null {
  return updateWindowFrameCache(window, {
    x: event.data?.x,
    y: event.data?.y,
  });
}

export function applyWindowResizeEvent(
  window: BrowserWindow | null,
  event: WindowResizeEvent,
  minimumSize?: WindowMinimumSize,
): WindowFrame | null {
  if (!window) return null;
  const previousFrame = getWindowFrame(window) ?? DEFAULT_WINDOW_FRAME;
  const rawFrame = normalizeWindowFrame(event.data ?? {}, previousFrame);
  const nextFrame = updateWindowFrameCache(window, rawFrame, minimumSize);
  if (nextFrame && (nextFrame.width !== rawFrame.width || nextFrame.height !== rawFrame.height)) {
    window.setFrame(nextFrame.x, nextFrame.y, nextFrame.width, nextFrame.height);
  }
  return nextFrame;
}
