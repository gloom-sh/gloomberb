import type { DesktopDisplay, Rect } from "./geometry";
import type { DesktopWindowHost, NativeWindowEvent, NativeWindowState, OpenWindowSpec } from "./window-host";

/** How long a new window has to draw before it is opened again, and then before the next one opens anyway. */
const DRAW_TIMEOUT_MS = 15_000;

interface WaitingWindow {
  spec: OpenWindowSpec;
  maximized?: boolean;
  fullscreen?: boolean;
  focus?: boolean;
}

interface OpeningWindow {
  spec: OpenWindowSpec;
  reopened: boolean;
  timer: unknown;
}

export interface SequentialWindowHostOptions {
  /**
   * Whether a window that has not drawn may be closed and opened once more.
   * Not the main window: on some systems closing it ends the app.
   */
  canReopen?: (spec: OpenWindowSpec) => boolean;
  /** A window that drew nothing, even opened again; the next one opens anyway. */
  onNeverDrew?: (id: string) => void;
  drawTimeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Opens native windows one at a time: the next once the last one's page has
 * drawn (`windowDrawn`). Asked for three new windows at once, the shell can
 * leave one blank for good; one that has not drawn in time is closed and
 * opened once more, and after that the next window opens anyway.
 *
 * A window waiting its turn already counts as open: a frame, mode, title or
 * focus asked for it is kept for when it opens. Everything else goes
 * straight to the shell, and its events come from the shell.
 */
export class SequentialWindowHost implements DesktopWindowHost {
  private readonly waiting: WaitingWindow[] = [];
  private opening: OpeningWindow | null = null;
  private readonly drawTimeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly shell: DesktopWindowHost, private readonly options: SequentialWindowHostOptions = {}) {
    this.drawTimeoutMs = options.drawTimeoutMs ?? DRAW_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    // The person closed the window that was opening: the next one need not wait for it.
    shell.onWindowEvent((event) => {
      if (event.type === "close" && this.opening?.spec.id === event.id) this.openNext();
    });
  }

  get canPlaceWindows(): boolean {
    return this.shell.canPlaceWindows;
  }

  get canFullscreen(): boolean {
    return this.shell.canFullscreen;
  }

  /** A window's page has drawn: the next window may open. */
  windowDrawn(id: string): void {
    if (this.opening?.spec.id === id) this.openNext();
  }

  listDisplays(): DesktopDisplay[] {
    return this.shell.listDisplays();
  }

  openWindow(spec: OpenWindowSpec): void {
    if (this.hasWindow(spec.id)) return;
    this.waiting.push({ spec: { ...spec, frame: { ...spec.frame } } });
    if (!this.opening) this.openNext();
  }

  closeWindow(id: string): void {
    const index = this.waiting.findIndex((entry) => entry.spec.id === id);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      return;
    }
    this.shell.closeWindow(id);
    if (this.opening?.spec.id === id) this.openNext();
  }

  hasWindow(id: string): boolean {
    return this.shell.hasWindow(id) || !!this.waitingWindow(id);
  }

  getWindowState(id: string): NativeWindowState | null {
    return this.shell.getWindowState(id);
  }

  setFrame(id: string, frame: Rect): void {
    const waiting = this.waitingWindow(id);
    if (waiting) waiting.spec = { ...waiting.spec, frame: { ...frame } };
    else this.shell.setFrame(id, frame);
  }

  setMaximized(id: string, maximized: boolean): void {
    const waiting = this.waitingWindow(id);
    if (waiting) waiting.maximized = maximized;
    else this.shell.setMaximized(id, maximized);
  }

  setFullscreen(id: string, fullscreen: boolean): void {
    const waiting = this.waitingWindow(id);
    if (waiting) waiting.fullscreen = fullscreen;
    else this.shell.setFullscreen(id, fullscreen);
  }

  setTitle(id: string, title: string): void {
    const waiting = this.waitingWindow(id);
    if (waiting) waiting.spec = { ...waiting.spec, title };
    else this.shell.setTitle(id, title);
  }

  focusWindow(id: string): void {
    const waiting = this.waitingWindow(id);
    if (waiting) waiting.focus = true;
    else this.shell.focusWindow(id);
  }

  onDisplaysChanged(listener: (displays: DesktopDisplay[]) => void): () => void {
    return this.shell.onDisplaysChanged(listener);
  }

  onWindowEvent(listener: (event: NativeWindowEvent) => void): () => void {
    return this.shell.onWindowEvent(listener);
  }

  private waitingWindow(id: string): WaitingWindow | undefined {
    return this.waiting.find((entry) => entry.spec.id === id);
  }

  /** The window that was opening is done with, drawn or not: the next in line opens. */
  private openNext(): void {
    if (this.opening) this.clearTimer(this.opening.timer);
    this.opening = null;
    const next = this.waiting.shift();
    if (next) this.open(next, false);
  }

  private open(entry: WaitingWindow, reopened: boolean): void {
    const { spec } = entry;
    // Set before the shell opens it, in case the page reports in at once.
    this.opening = { spec, reopened, timer: this.setTimer(() => this.timedOut(spec.id), this.drawTimeoutMs) };
    this.shell.openWindow(spec);
    if (entry.fullscreen && this.shell.canFullscreen) this.shell.setFullscreen(spec.id, true);
    else if (entry.maximized) this.shell.setMaximized(spec.id, true);
    if (entry.focus) this.shell.focusWindow(spec.id);
  }

  private timedOut(id: string): void {
    const opening = this.opening;
    if (!opening || opening.spec.id !== id) return;
    if (!opening.reopened && this.shell.hasWindow(id) && (this.options.canReopen?.(opening.spec) ?? true)) {
      // Opened again where it is now and in the mode it is in.
      const state = this.shell.getWindowState(id);
      const windowed = !!state && !state.maximized && !state.fullscreen && !state.minimized;
      this.shell.closeWindow(id);
      this.open({
        spec: { ...opening.spec, frame: windowed ? { ...state.frame } : opening.spec.frame },
        maximized: state?.maximized,
        fullscreen: state?.fullscreen,
      }, true);
      return;
    }
    this.options.onNeverDrew?.(id);
    this.openNext();
  }
}
