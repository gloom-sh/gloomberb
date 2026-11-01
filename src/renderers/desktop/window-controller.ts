import {
  arrangementKey,
  cascadeFrame,
  clampFrameToScreens,
  displayForFrame,
  displayFromKey,
  displayKey,
  isUsableRect,
  moveFrameToDisplay,
  relocateFrame,
  sameRect,
  usableDisplays,
  type DesktopDisplay,
  type Rect,
} from "./geometry";
import {
  MAIN_WINDOW_ID,
  forgetWindow,
  hasArrangement,
  latestPlacementFor,
  placementFor,
  rememberPlacement,
  restoreWindow,
  withExtraWindows,
  type ExtraWindowRecord,
  type ScreenSetup,
  type WindowPlacement,
} from "./screen-setup";
import type { DesktopWindowHost, NativeWindowEvent, WindowSize } from "./window-host";

/**
 * A quit this soon after extra windows closed keeps them for the next launch:
 * closing every window at once (the Windows taskbar, logging out) closes
 * them one by one, maybe the main window, and so the quit, last.
 */
const QUIT_GRACE_MS = 1_000;

export interface ScreenSetupStore {
  load(): ScreenSetup;
  save(setup: ScreenSetup): void;
}

export interface DesktopWindowControllerOptions {
  host: DesktopWindowHost;
  store: ScreenSetupStore;
  minSize: WindowSize;
  /** Where the main window opens when nothing was saved for these screens. */
  defaultMainFrame: Rect;
  /** The main window as an older build saved it, used once when the setup has nothing for it yet. */
  legacyMainPlacement?: WindowPlacement | null;
  title?: (windowId: string) => string;
  /**
   * The person closed an extra window; its tabs go back to the main window.
   * A quit that follows within `QUIT_GRACE_MS` keeps it for the next launch.
   */
  onWindowClosed?: (windowId: string) => void;
  onMainWindowClosed?: () => void;
  onWindowFocused?: (windowId: string) => void;
  onWindowVisibility?: (windowId: string, visible: boolean) => void;
  /** Another shell's pane windows share the host; their events are theirs. */
  onOtherWindowEvent?: (event: NativeWindowEvent) => void;
  now?: () => number;
  saveDelayMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The full app windows on screen: where each opens, keeping where each sits
 * for the monitor arrangement in use, and putting them back when the screens
 * change. Unplugging a display folds its windows onto the displays that
 * remain, keeping their place on the screen in proportion; plugging it back
 * restores the setup saved for that arrangement. Whatever the setup says,
 * every window this side places lands on a screen that is connected: the
 * shell does not pull back a window asked to open off screen.
 */
export class DesktopWindowController {
  private setup: ScreenSetup;
  private displays: DesktopDisplay[];
  private arrangement: string;
  private readonly open = new Set<string>();
  /** Each window's last frame while neither maximized nor full screen, which is what a restore returns to. */
  private readonly windowedFrames = new Map<string, Rect>();
  private readonly saveTimers = new Map<string, unknown>();
  private focused: string = MAIN_WINDOW_ID;
  /** Extra windows the person closed, with the setup from just before, for a quit right after. */
  private recentlyClosed: Array<{ windowId: string; at: number; before: ScreenSetup }> = [];
  private readonly disposers: Array<() => void> = [];
  private readonly now: () => number;
  private readonly saveDelayMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** Windows this side is moving, whose frame events are its own and not the person's. */
  private applying = 0;

  constructor(private readonly options: DesktopWindowControllerOptions) {
    this.setup = options.store.load();
    this.displays = usableDisplays(options.host.listDisplays());
    this.arrangement = arrangementKey(this.displays);
    this.now = options.now ?? Date.now;
    this.saveDelayMs = options.saveDelayMs ?? 300;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.disposers.push(
      options.host.onDisplaysChanged((displays) => this.handleDisplays(displays)),
      options.host.onWindowEvent((event) => this.handleWindowEvent(event)),
    );
  }

  get screenSetup(): ScreenSetup {
    return this.setup;
  }

  get currentArrangement(): string {
    return this.arrangement;
  }

  get focusedWindowId(): string {
    return this.focused;
  }

  isOpen(windowId: string): boolean {
    return this.open.has(windowId);
  }

  openWindowIds(): string[] {
    return [...this.open];
  }

  /** The extra windows the workspace has now, kept for the next launch. */
  rememberWindows(records: readonly ExtraWindowRecord[]): void {
    this.commit(withExtraWindows(this.setup, records));
  }

  /**
   * Where a window opens, always on a connected screen: what was saved for
   * these screens; else where it last sat on other screens, moved onto
   * these (a monitor unplugged, a new resolution); else a place of its own.
   */
  placementFor(windowId: string): WindowPlacement {
    const saved = placementFor(this.setup, this.arrangement, windowId);
    if (saved) return { ...saved, frame: this.onScreen(saved.frame) };
    const earlier = latestPlacementFor(this.setup, windowId, this.arrangement);
    if (earlier) return { ...earlier, frame: this.carryOver(windowId, earlier) };
    const legacy = windowId === MAIN_WINDOW_ID ? this.options.legacyMainPlacement : null;
    if (legacy) return { ...legacy, frame: this.onScreen(legacy.frame) };
    if (windowId === MAIN_WINDOW_ID) {
      return { frame: this.onScreen(this.options.defaultMainFrame), maximized: false, fullscreen: false };
    }
    return { frame: this.onScreen(this.freshFrame()), maximized: false, fullscreen: false };
  }

  openWindow(windowId: string): void {
    if (this.open.has(windowId)) {
      this.focus(windowId);
      return;
    }
    const placement = this.placementFor(windowId);
    this.open.add(windowId);
    this.windowedFrames.set(windowId, placement.frame);
    this.options.host.openWindow({
      id: windowId,
      kind: "app",
      title: this.options.title?.(windowId) ?? "Gloom",
      frame: placement.frame,
      minSize: this.options.minSize,
    });
    this.applyModes(windowId, placement);
  }

  /**
   * Closes a window from this side: its placements stay unless `forget`, for
   * a window closed for good. Where it was last moved is saved first.
   */
  closeWindow(windowId: string, options: { forget?: boolean } = {}): void {
    const moved = this.saveTimers.has(windowId);
    this.cancelSave(windowId);
    if (moved && !options.forget) this.remember(windowId);
    if (this.open.delete(windowId)) this.options.host.closeWindow(windowId);
    this.windowedFrames.delete(windowId);
    if (options.forget) this.commit(forgetWindow(this.setup, windowId));
  }

  focus(windowId: string): void {
    if (!this.open.has(windowId)) return;
    this.focused = windowId;
    this.options.host.focusWindow(windowId);
  }

  /**
   * Writes every open window's placement now, for a quit: a window that was
   * never moved has saved nothing yet, and opens where it is next time too.
   * Extra windows closed just before come back with it (`QUIT_GRACE_MS`).
   */
  flush(): void {
    for (const windowId of [...this.saveTimers.keys()]) this.cancelSave(windowId);
    for (const windowId of this.open) this.remember(windowId);
    const since = this.now() - QUIT_GRACE_MS;
    let setup = this.setup;
    for (const closed of this.recentlyClosed.splice(0)) {
      if (closed.at >= since) setup = restoreWindow(setup, closed.before, closed.windowId);
    }
    this.commit(setup);
  }

  dispose(): void {
    for (const windowId of [...this.saveTimers.keys()]) this.cancelSave(windowId);
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  /** A display with no window on it, for a new window; else the focused window's display. */
  private freshFrame(): Rect {
    const mainFrame = this.liveFrame(MAIN_WINDOW_ID) ?? this.options.defaultMainFrame;
    const occupied = new Set(
      [...this.open]
        .map((id) => this.liveFrame(id))
        .flatMap((frame) => {
          const display = frame ? displayForFrame(frame, this.displays) : null;
          return display ? [displayKey(display)] : [];
        }),
    );
    const empty = this.displays.find((display) => !occupied.has(displayKey(display)));
    if (empty) return moveFrameToDisplay(mainFrame, displayForFrame(mainFrame, this.displays), empty);
    const anchor = this.liveFrame(this.focused) ?? mainFrame;
    const display = displayForFrame(anchor, this.displays) ?? this.displays[0];
    return display ? cascadeFrame(anchor, display) : anchor;
  }

  /**
   * A frame on a connected screen. Where the system places windows itself
   * (Wayland), only the size is this side's, and it still fits a screen.
   */
  /**
   * A frame a window can open at: at least the minimum size, as the window
   * cannot be made smaller, and on a connected screen. On a screen smaller
   * than the minimum it keeps its top left corner there.
   */
  private onScreen(frame: Rect): Rect {
    const sized = this.atLeastMinimum(frame);
    if (this.displays.length === 0) return sized;
    const fitted = this.atLeastMinimum(clampFrameToScreens(sized, this.displays));
    return this.options.host.canPlaceWindows ? fitted : { ...sized, width: fitted.width, height: fitted.height };
  }

  private atLeastMinimum(frame: Rect): Rect {
    const { width, height } = this.options.minSize;
    return { ...frame, width: Math.max(frame.width, width), height: Math.max(frame.height, height) };
  }

  /** The display the windows fold onto when theirs is gone: the main window's, else the primary one. */
  private foldTarget(windowId: string, displays: readonly DesktopDisplay[]): DesktopDisplay | null {
    const mainFrame = windowId === MAIN_WINDOW_ID ? null : this.liveFrame(MAIN_WINDOW_ID);
    return (mainFrame ? displayForFrame(mainFrame, displays) : null) ?? displays[0] ?? null;
  }

  /** A placement saved under other screens, moved onto these. */
  private carryOver(windowId: string, placement: WindowPlacement): Rect {
    const from = placement.display ? displayFromKey(placement.display) : null;
    const target = this.foldTarget(windowId, this.displays);
    const frame = target ? relocateFrame(placement.frame, from, this.displays, target) : placement.frame;
    return this.onScreen(frame);
  }

  private liveFrame(windowId: string): Rect | null {
    const state = this.open.has(windowId) ? this.options.host.getWindowState(windowId) : null;
    if (!state) return this.windowedFrames.get(windowId) ?? null;
    if (state.minimized || state.maximized || state.fullscreen) return this.windowedFrames.get(windowId) ?? state.frame;
    return isUsableRect(state.frame) ? state.frame : this.windowedFrames.get(windowId) ?? null;
  }

  private applyModes(windowId: string, placement: WindowPlacement): void {
    const { host } = this.options;
    if (placement.fullscreen && host.canFullscreen) host.setFullscreen(windowId, true);
    else if (placement.maximized) host.setMaximized(windowId, true);
  }

  private commit(next: ScreenSetup): void {
    if (next === this.setup) return;
    this.setup = next;
    this.options.store.save(next);
  }

  private cancelSave(windowId: string): void {
    const timer = this.saveTimers.get(windowId);
    if (timer === undefined) return;
    this.clearTimer(timer);
    this.saveTimers.delete(windowId);
  }

  private scheduleSave(windowId: string): void {
    this.cancelSave(windowId);
    this.saveTimers.set(windowId, this.setTimer(() => {
      this.saveTimers.delete(windowId);
      // The system moves windows off a display it lost before anything says
      // the display is gone; those moves belong to the new arrangement and
      // must not overwrite where the windows sat on the old one.
      const displays = this.options.host.listDisplays();
      if (arrangementKey(displays) !== this.arrangement) {
        this.handleDisplays(displays);
        return;
      }
      this.remember(windowId);
    }, this.saveDelayMs));
  }

  /** Records where a window is now under the arrangement in use. Nothing while it is minimized. */
  private remember(windowId: string): void {
    const state = this.open.has(windowId) ? this.options.host.getWindowState(windowId) : null;
    if (!state || state.minimized || !isUsableRect(state.frame)) return;
    if (!state.maximized && !state.fullscreen) this.windowedFrames.set(windowId, state.frame);
    const frame = this.windowedFrames.get(windowId) ?? state.frame;
    const display = displayForFrame(state.frame, this.displays);
    this.commit(rememberPlacement(this.setup, this.arrangement, windowId, {
      frame,
      maximized: state.maximized && !state.fullscreen,
      fullscreen: state.fullscreen,
      ...(display ? { display: displayKey(display) } : {}),
    }, this.now()));
  }

  private handleWindowEvent(event: NativeWindowEvent): void {
    if (!this.open.has(event.id)) {
      this.options.onOtherWindowEvent?.(event);
      return;
    }
    switch (event.type) {
      case "frame":
        if (this.applying === 0) this.scheduleSave(event.id);
        return;
      case "focus":
        this.focused = event.id;
        this.options.onWindowFocused?.(event.id);
        return;
      case "visibility":
        this.options.onWindowVisibility?.(event.id, event.visible);
        return;
      case "close":
        // Read now: the host still answers for the window while its close is reported.
        this.cancelSave(event.id);
        this.remember(event.id);
        this.open.delete(event.id);
        this.windowedFrames.delete(event.id);
        if (event.id === MAIN_WINDOW_ID) {
          this.options.onMainWindowClosed?.();
          return;
        }
        this.recentlyClosed = [
          ...this.recentlyClosed.filter((closed) => closed.at >= this.now() - QUIT_GRACE_MS),
          { windowId: event.id, at: this.now(), before: this.setup },
        ];
        this.commit(forgetWindow(this.setup, event.id));
        this.options.onWindowClosed?.(event.id);
        return;
    }
  }

  /**
   * The screens changed. A setup saved for the new arrangement is put back
   * as it was; otherwise each window whose display is gone moves onto one
   * that remains, at the same place in proportion and in the same mode: the
   * same screen at its new resolution, else the main window's display.
   * Windows still on a display stay. All of them end up on screen.
   */
  handleDisplays(nextDisplays: readonly DesktopDisplay[]): void {
    const displays = usableDisplays(nextDisplays);
    const key = arrangementKey(displays);
    if (key === this.arrangement || displays.length === 0) return;
    const previousDisplays = this.displays;
    this.displays = displays;
    this.arrangement = key;
    const restoring = hasArrangement(this.setup, key);
    const { host } = this.options;
    const restored = new Set<string>();
    this.applying += 1;
    try {
      // The main window first: the others fold onto the display it ends up on.
      const order = [...this.open].sort((a, b) => Number(b === MAIN_WINDOW_ID) - Number(a === MAIN_WINDOW_ID));
      for (const windowId of order) {
        this.cancelSave(windowId);
        const saved = restoring ? placementFor(this.setup, key, windowId) : null;
        if (saved) {
          this.place(windowId, { ...saved, frame: this.onScreen(saved.frame) });
          restored.add(windowId);
          continue;
        }
        // A window still waiting its turn to open has no native state yet; it opens where this puts it.
        const waiting = this.windowedFrames.get(windowId);
        const state = host.getWindowState(windowId)
          ?? (waiting ? { frame: waiting, maximized: false, fullscreen: false, minimized: false } : null);
        if (!state) continue;
        // Where the window sat before the change: the system may already have moved it.
        const windowed = this.windowedFrames.get(windowId) ?? state.frame;
        const from = displayForFrame(windowed, previousDisplays);
        const stillThere = !!from && displays.some((display) => displayKey(display) === displayKey(from));
        if (stillThere) {
          const frame = this.onScreen(windowed);
          this.windowedFrames.set(windowId, frame);
          if (!sameRect(state.frame, frame) && !state.maximized && !state.fullscreen && host.canPlaceWindows) {
            host.setFrame(windowId, frame);
          }
          continue;
        }
        const target = this.foldTarget(windowId, displays) ?? displays[0]!;
        this.place(windowId, {
          frame: this.onScreen(relocateFrame(windowed, from, displays, target)),
          maximized: state.maximized,
          fullscreen: state.fullscreen,
        });
      }
    } finally {
      this.applying -= 1;
    }
    // The new arrangement starts from where the windows are now; a restored one already has its entry.
    for (const windowId of this.open) {
      if (!restored.has(windowId)) this.remember(windowId);
    }
  }

  private place(windowId: string, placement: WindowPlacement): void {
    const { host } = this.options;
    const state = host.getWindowState(windowId);
    this.windowedFrames.set(windowId, placement.frame);
    if (!host.canPlaceWindows) {
      if (state && (state.maximized !== placement.maximized)) host.setMaximized(windowId, placement.maximized);
      return;
    }
    // A maximized or full screen window takes a frame only once it is back to normal.
    if (state?.fullscreen && host.canFullscreen) host.setFullscreen(windowId, false);
    if (state?.maximized) host.setMaximized(windowId, false);
    if (!state || !sameRect(state.frame, placement.frame)) host.setFrame(windowId, placement.frame);
    this.applyModes(windowId, placement);
  }
}
