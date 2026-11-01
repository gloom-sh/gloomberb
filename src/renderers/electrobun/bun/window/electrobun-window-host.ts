import { Screen, type BrowserWindow } from "electrobun/bun";
import { arrangementKey, type DesktopDisplay, type Rect } from "../../../desktop/geometry";
import type {
  DesktopWindowHost,
  NativeWindowEvent,
  NativeWindowState,
  OpenWindowSpec,
} from "../../../desktop/window-host";
import { getWindowFrame, updateWindowFrameCache } from "./events";
import type { FocusableElectrobunWindow } from "./focus";

/**
 * Electrobun 1.18 has no event for displays coming and going, nor for a window
 * being minimized: both are read on a timer this long.
 */
const POLL_MS = 1_500;

export interface ElectrobunWindowHostOptions {
  /**
   * Makes the native window: the view it loads, its RPC channel and preload
   * are the backend's. `onFrameChange` runs after each move or resize.
   */
  create(spec: OpenWindowSpec, hooks: { onFrameChange: () => void }): BrowserWindow;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
}

type ElectrobunDisplay = ReturnType<typeof Screen.getAllDisplays>[number];

function toRect(value: Partial<Rect> | undefined, fallback: Rect): Rect {
  return {
    x: typeof value?.x === "number" ? value.x : fallback.x,
    y: typeof value?.y === "number" ? value.y : fallback.y,
    width: typeof value?.width === "number" ? value.width : fallback.width,
    height: typeof value?.height === "number" ? value.height : fallback.height,
  };
}

function readElectrobunDisplays(read: () => ElectrobunDisplay[] = Screen.getAllDisplays): DesktopDisplay[] {
  try {
    return read().map((display) => {
      const bounds = toRect(display.bounds, { x: 0, y: 0, width: 0, height: 0 });
      return {
        id: String(display.id),
        bounds,
        workArea: toRect(display.workArea, bounds),
        scaleFactor: typeof display.scaleFactor === "number" && display.scaleFactor > 0 ? display.scaleFactor : 1,
        primary: display.isPrimary === true,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Whether windows can place themselves. Under a Wayland session GTK talks to
 * the compositor, which ignores a window's own position; run through XWayland
 * (GDK_BACKEND=x11) they can.
 */
function canPlaceWindowsOn(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "linux") return true;
  const wayland = env.XDG_SESSION_TYPE === "wayland" || !!env.WAYLAND_DISPLAY;
  return !wayland || env.GDK_BACKEND === "x11";
}

/** The desktop window host on Electrobun 1.18: windows, their frames and events, and the displays. */
export class ElectrobunWindowHost implements DesktopWindowHost {
  readonly canPlaceWindows: boolean;
  /** Windows has no way into full screen with Electrobun's frameless windows. */
  readonly canFullscreen: boolean;
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly minimized = new Map<string, boolean>();
  private readonly displayListeners = new Set<(displays: DesktopDisplay[]) => void>();
  private readonly windowListeners = new Set<(event: NativeWindowEvent) => void>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastArrangement: string;

  constructor(private readonly options: ElectrobunWindowHostOptions) {
    const platform = options.platform ?? process.platform;
    this.canPlaceWindows = canPlaceWindowsOn(platform, options.env ?? process.env);
    this.canFullscreen = platform !== "win32";
    this.lastArrangement = arrangementKey(this.listDisplays());
  }

  /** The Electrobun window, for the few calls only this shell makes (its native handle, devtools). */
  browserWindow(id: string): BrowserWindow | null {
    return this.windows.get(id) ?? null;
  }

  listDisplays(): DesktopDisplay[] {
    return readElectrobunDisplays();
  }

  openWindow(spec: OpenWindowSpec): void {
    if (this.windows.has(spec.id)) return;
    const window = this.options.create(spec, { onFrameChange: () => this.emit({ type: "frame", id: spec.id }) });
    this.windows.set(spec.id, window);
    this.minimized.set(spec.id, false);
    const on = (window as { on?: (name: string, handler: (event: unknown) => void) => void }).on;
    on?.call(window, "focus", () => this.emit({ type: "focus", id: spec.id }));
    on?.call(window, "close", () => {
      // Only the person's closes are reported: `closeWindow` forgets the window first.
      if (this.windows.get(spec.id) !== window) return;
      this.windows.delete(spec.id);
      this.minimized.delete(spec.id);
      this.emit({ type: "close", id: spec.id });
    });
    this.startPolling();
  }

  closeWindow(id: string): void {
    const window = this.windows.get(id);
    if (!window) return;
    this.windows.delete(id);
    this.minimized.delete(id);
    window.close();
  }

  hasWindow(id: string): boolean {
    return this.windows.has(id);
  }

  getWindowState(id: string): NativeWindowState | null {
    const window = this.windows.get(id);
    const frame = getWindowFrame(window ?? null);
    if (!window || !frame) return null;
    const read = (call: () => boolean) => {
      try {
        return call() === true;
      } catch {
        return false;
      }
    };
    const fullscreen = this.canFullscreen && read(() => window.isFullScreen());
    return {
      frame,
      fullscreen,
      maximized: !fullscreen && read(() => window.isMaximized()),
      minimized: read(() => window.isMinimized()),
    };
  }

  setFrame(id: string, frame: Rect): void {
    const window = this.windows.get(id);
    if (!window) return;
    window.setFrame(frame.x, frame.y, frame.width, frame.height);
    updateWindowFrameCache(window, frame);
  }

  setMaximized(id: string, maximized: boolean): void {
    const window = this.windows.get(id);
    try {
      if (maximized) window?.maximize();
      else window?.unmaximize();
    } catch {
      // The window keeps the frame it has.
    }
  }

  setFullscreen(id: string, fullscreen: boolean): void {
    if (!this.canFullscreen) return;
    try {
      this.windows.get(id)?.setFullScreen(fullscreen);
    } catch {
      // The window keeps the frame it has.
    }
  }

  setTitle(id: string, title: string): void {
    (this.windows.get(id) as { setTitle?: (title: string) => void } | undefined)?.setTitle?.(title);
  }

  focusWindow(id: string): void {
    const window = this.windows.get(id) as FocusableElectrobunWindow | undefined;
    if (!window) return;
    if (this.minimized.get(id)) {
      try {
        (window as unknown as BrowserWindow).unminimize();
      } catch {
        // Focusing it still brings it forward where the system allows.
      }
    }
    if (window.activate) window.activate();
    else window.focus?.();
  }

  onDisplaysChanged(listener: (displays: DesktopDisplay[]) => void): () => void {
    this.displayListeners.add(listener);
    this.startPolling();
    return () => {
      this.displayListeners.delete(listener);
    };
  }

  onWindowEvent(listener: (event: NativeWindowEvent) => void): () => void {
    this.windowListeners.add(listener);
    return () => {
      this.windowListeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private emit(event: NativeWindowEvent): void {
    for (const listener of [...this.windowListeners]) listener(event);
  }

  private startPolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => this.check(), this.options.pollMs ?? POLL_MS);
    (this.poll as { unref?: () => void }).unref?.();
  }

  private check(): void {
    const displays = this.listDisplays();
    const arrangement = arrangementKey(displays);
    if (displays.length > 0 && arrangement !== this.lastArrangement) {
      this.lastArrangement = arrangement;
      for (const listener of [...this.displayListeners]) listener(displays);
    }
    for (const [id, window] of this.windows) {
      let minimized = false;
      try {
        minimized = window.isMinimized() === true;
      } catch {
        continue;
      }
      if (this.minimized.get(id) === minimized) continue;
      this.minimized.set(id, minimized);
      this.emit({ type: "visibility", id, visible: !minimized });
    }
  }
}
