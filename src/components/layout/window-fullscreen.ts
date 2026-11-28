import { useSyncExternalStore } from "react";
import { createListenerSet } from "../../utils/listeners";

let windowFullscreen = false;
let windowMaximized = false;
const listeners = createListenerSet();

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
  listeners.notify();
}

export function useWindowFullscreen(): boolean {
  return useSyncExternalStore(listeners.subscribe, () => windowFullscreen, () => false);
}

/**
 * Whether the window hosting this view is maximized. On Windows it then has
 * no edge to resize from, and its buttons run to the screen's top edge.
 */
export function setWindowMaximized(next: boolean): void {
  if (windowMaximized === next) return;
  windowMaximized = next;
  listeners.notify();
}

export function useWindowMaximized(): boolean {
  return useSyncExternalStore(listeners.subscribe, () => windowMaximized, () => false);
}
