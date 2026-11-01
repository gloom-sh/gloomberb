import type { DesktopDisplay, Rect } from "./geometry";
import type { DesktopWindowHost, NativeWindowEvent, NativeWindowState, OpenWindowSpec } from "./window-host";

/** A shell in memory: windows are frames and flags, and every change is synchronous. */
export class FakeHost implements DesktopWindowHost {
  canPlaceWindows = true;
  canFullscreen = true;
  displays: DesktopDisplay[];
  readonly windows = new Map<string, NativeWindowState & { spec: OpenWindowSpec }>();
  /** Every window the shell was asked to open, in order, opened again ones included. */
  readonly opened: string[] = [];
  private displayListeners = new Set<(displays: DesktopDisplay[]) => void>();
  private windowListeners = new Set<(event: NativeWindowEvent) => void>();

  constructor(displays: DesktopDisplay[]) {
    this.displays = displays;
  }

  listDisplays() { return this.displays; }
  openWindow(spec: OpenWindowSpec) {
    this.opened.push(spec.id);
    this.windows.set(spec.id, { spec, frame: spec.frame, maximized: false, fullscreen: false, minimized: false });
  }
  closeWindow(id: string) { this.windows.delete(id); }
  hasWindow(id: string) { return this.windows.has(id); }
  getWindowState(id: string) {
    const window = this.windows.get(id);
    return window ? { frame: window.frame, maximized: window.maximized, fullscreen: window.fullscreen, minimized: window.minimized } : null;
  }
  setFrame(id: string, frame: Rect) {
    const window = this.windows.get(id);
    if (window) window.frame = frame;
  }
  setMaximized(id: string, maximized: boolean) {
    const window = this.windows.get(id);
    if (window) window.maximized = maximized;
  }
  setFullscreen(id: string, fullscreen: boolean) {
    const window = this.windows.get(id);
    if (window) window.fullscreen = fullscreen;
  }
  setTitle() {}
  focusWindow() {}
  onDisplaysChanged(listener: (displays: DesktopDisplay[]) => void) {
    this.displayListeners.add(listener);
    return () => this.displayListeners.delete(listener);
  }
  onWindowEvent(listener: (event: NativeWindowEvent) => void) {
    this.windowListeners.add(listener);
    return () => this.windowListeners.delete(listener);
  }

  /** The person or the system moved a window. */
  move(id: string, frame: Rect, flags: Partial<NativeWindowState> = {}) {
    Object.assign(this.windows.get(id)!, { frame, ...flags });
    for (const listener of this.windowListeners) listener({ type: "frame", id });
  }
  close(id: string) {
    this.windows.delete(id);
    for (const listener of this.windowListeners) listener({ type: "close", id });
  }
  setDisplays(displays: DesktopDisplay[]) {
    this.displays = displays;
    for (const listener of this.displayListeners) listener(displays);
  }
}
