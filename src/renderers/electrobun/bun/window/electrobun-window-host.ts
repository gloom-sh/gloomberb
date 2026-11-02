import type { BrowserWindow, Screen } from "electrobun/bun";
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
 * being minimized: both are read on a timer, this often while there is more
 * than one window...
 */
const POLL_MS = 3_000;
/**
 * ...and this often with one, which reads the displays only: its page's own
 * visibility says when it is hidden, as it did before there were more windows.
 */
const QUIET_POLL_MS = 10_000;
/**
 * A window's own events read whether it is minimized at once, so one coming
 * back redraws without waiting for the timer: a focus, a move or a resize
 * (a restore on Windows). A blur reads it again this long after, once the
 * minimize animation has run.
 */
const AFTER_BLUR_MS = 600;

export interface ElectrobunWindowHostOptions {
  /**
   * Makes the native window: the view it loads, its RPC channel and preload
   * are the backend's. `onFrameChange` runs after each move or resize.
   */
  create(spec: OpenWindowSpec, hooks: { onFrameChange: () => void }): BrowserWindow;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The displays as Electrobun lists them: `Screen.getAllDisplays`. */
  readDisplays: () => ElectrobunDisplay[];
  pollMs?: number;
  quietPollMs?: number;
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

function readElectrobunDisplays(read: () => ElectrobunDisplay[]): DesktopDisplay[] {
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

/** A native yes or no; false when the window cannot answer. */
function read(call: () => boolean): boolean {
  try {
    return call() === true;
  } catch {
    return false;
  }
}

/** The desktop window host on Electrobun 1.18: windows, their frames and events, and the displays. */
export class ElectrobunWindowHost implements DesktopWindowHost {
  readonly canPlaceWindows: boolean;
  /** Windows has no way into full screen with Electrobun's frameless windows. */
  readonly canFullscreen: boolean;
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly minimized = new Map<string, boolean>();
  /** Each window's maximized and full screen state as last read: a closed window cannot be asked. */
  private readonly modes = new Map<string, { maximized: boolean; fullscreen: boolean }>();
  /** A window closed from outside, as last known, while its close is being reported. */
  private readonly closing = new Map<string, NativeWindowState>();
  private readonly displayListeners = new Set<(displays: DesktopDisplay[]) => void>();
  private readonly windowListeners = new Set<(event: NativeWindowEvent) => void>();
  private poll: ReturnType<typeof setTimeout> | null = null;
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
    return readElectrobunDisplays(this.options.readDisplays);
  }

  openWindow(spec: OpenWindowSpec): void {
    if (this.windows.has(spec.id)) return;
    const window = this.options.create(spec, {
      onFrameChange: () => {
        this.checkMinimized(spec.id);
        this.readModes(spec.id);
        this.emit({ type: "frame", id: spec.id });
      },
    });
    this.windows.set(spec.id, window);
    this.minimized.set(spec.id, false);
    const on = (window as { on?: (name: string, handler: (event: unknown) => void) => void }).on;
    on?.call(window, "focus", () => {
      this.checkMinimized(spec.id);
      this.emit({ type: "focus", id: spec.id });
    });
    on?.call(window, "blur", () => {
      this.checkMinimized(spec.id);
      setTimeout(() => this.checkMinimized(spec.id), AFTER_BLUR_MS);
    });
    on?.call(window, "close", () => {
      // Only the person's closes are reported: `closeWindow` forgets the window first.
      if (this.windows.get(spec.id) !== window) return;
      // The native window is gone: what is known of it answers while its close is reported.
      const frame = getWindowFrame(window);
      const modes = this.modes.get(spec.id) ?? { maximized: false, fullscreen: false };
      if (frame) this.closing.set(spec.id, { frame, ...modes, minimized: this.minimized.get(spec.id) === true });
      this.forget(spec.id);
      try {
        this.emit({ type: "close", id: spec.id });
      } finally {
        this.closing.delete(spec.id);
      }
    });
    // A second window reads sooner than the timer one window left.
    this.schedulePoll(true);
  }

  closeWindow(id: string): void {
    const window = this.windows.get(id);
    if (!window) return;
    this.forget(id);
    window.close();
  }

  private forget(id: string): void {
    this.windows.delete(id);
    this.minimized.delete(id);
    this.modes.delete(id);
  }

  hasWindow(id: string): boolean {
    return this.windows.has(id);
  }

  getWindowState(id: string): NativeWindowState | null {
    const window = this.windows.get(id);
    if (!window) return this.closing.get(id) ?? null;
    const frame = getWindowFrame(window);
    if (!frame) return null;
    return { frame, ...this.readModes(id), minimized: read(() => window.isMinimized()) };
  }

  private readModes(id: string): { maximized: boolean; fullscreen: boolean } {
    const window = this.windows.get(id);
    if (!window) return { maximized: false, fullscreen: false };
    const fullscreen = this.canFullscreen && read(() => window.isFullScreen());
    const modes = { maximized: !fullscreen && read(() => window.isMaximized()), fullscreen };
    this.modes.set(id, modes);
    return modes;
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
    this.schedulePoll(false);
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
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
  }

  private emit(event: NativeWindowEvent): void {
    for (const listener of [...this.windowListeners]) listener(event);
  }

  private pollInterval(): number {
    return this.windows.size > 1 ? this.options.pollMs ?? POLL_MS : this.options.quietPollMs ?? QUIET_POLL_MS;
  }

  /** Sets the next read; `sooner` moves one already set closer when there are now more windows. */
  private schedulePoll(sooner: boolean): void {
    if (this.poll && !sooner) return;
    if (this.poll) clearTimeout(this.poll);
    this.poll = setTimeout(() => {
      this.poll = null;
      this.check();
      this.schedulePoll(false);
    }, this.pollInterval());
    (this.poll as { unref?: () => void }).unref?.();
  }

  private check(): void {
    const displays = this.listDisplays();
    const arrangement = arrangementKey(displays);
    if (displays.length > 0 && arrangement !== this.lastArrangement) {
      this.lastArrangement = arrangement;
      for (const listener of [...this.displayListeners]) listener(displays);
    }
    if (this.windows.size > 1) {
      for (const id of this.windows.keys()) this.checkMinimized(id);
    }
  }

  private checkMinimized(id: string): void {
    const window = this.windows.get(id);
    if (!window) return;
    let minimized: boolean;
    try {
      minimized = window.isMinimized() === true;
    } catch {
      return;
    }
    if (this.minimized.get(id) === minimized) return;
    this.minimized.set(id, minimized);
    this.emit({ type: "visibility", id, visible: !minimized });
  }
}
