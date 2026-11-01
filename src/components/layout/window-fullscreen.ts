import { useSyncExternalStore } from "react";

let windowFullscreen = false;
const listeners = new Set<() => void>();

/**
 * Whether the window hosting this view is in the platform's own fullscreen,
 * which is not the same as a pane being maximized inside the workspace. Only
 * the desktop host knows: a webview cannot see its window's style mask, and
 * macOS hides the traffic lights there, so the header has to stop holding
 * columns for controls that are no longer on screen.
 */
export function setWindowFullscreen(next: boolean): void {
  if (windowFullscreen === next) return;
  windowFullscreen = next;
  for (const listener of [...listeners]) listener();
}

function isWindowFullscreen(): boolean {
  return windowFullscreen;
}

function subscribeWindowFullscreen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWindowFullscreen(): boolean {
  return useSyncExternalStore(subscribeWindowFullscreen, isWindowFullscreen, () => false);
}

let windowMaximized = false;

/**
 * Whether the window hosting this view is maximized. On Windows it then has
 * no edge to resize from, and its buttons run to the screen's top edge.
 */
export function setWindowMaximized(next: boolean): void {
  if (windowMaximized === next) return;
  windowMaximized = next;
  for (const listener of [...listeners]) listener();
}

function isWindowMaximized(): boolean {
  return windowMaximized;
}

export function useWindowMaximized(): boolean {
  return useSyncExternalStore(subscribeWindowFullscreen, isWindowMaximized, () => false);
}
