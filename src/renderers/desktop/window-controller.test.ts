import { describe, expect, test } from "bun:test";
import { arrangementKey, type DesktopDisplay, type Rect } from "./geometry";
import { MAIN_WINDOW_ID, emptyScreenSetup, parseScreenSetup, placementFor, type ScreenSetup } from "./screen-setup";
import { DesktopWindowController } from "./window-controller";
import type { DesktopWindowHost, NativeWindowEvent, NativeWindowState, OpenWindowSpec } from "./window-host";

function display(id: string, bounds: Rect, primary = false): DesktopDisplay {
  return { id, bounds, workArea: { ...bounds, y: bounds.y + 25, height: bounds.height - 25 }, scaleFactor: 2, primary };
}

const LAPTOP = display("1", { x: 0, y: 0, width: 1512, height: 982 }, true);
const EXTERNAL = display("2", { x: 1512, y: 0, width: 2560, height: 1440 });

/** A shell in memory: windows are frames and flags, and every change is synchronous. */
class FakeHost implements DesktopWindowHost {
  canPlaceWindows = true;
  canFullscreen = true;
  displays: DesktopDisplay[];
  readonly windows = new Map<string, NativeWindowState & { spec: OpenWindowSpec }>();
  private displayListeners = new Set<(displays: DesktopDisplay[]) => void>();
  private windowListeners = new Set<(event: NativeWindowEvent) => void>();

  constructor(displays: DesktopDisplay[]) {
    this.displays = displays;
  }

  listDisplays() { return this.displays; }
  openWindow(spec: OpenWindowSpec) {
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

function setup(host: FakeHost, saved: ScreenSetup = emptyScreenSetup()) {
  const store = { current: saved, saves: 0 };
  const timers: Array<() => void> = [];
  const closed: string[] = [];
  const controller = new DesktopWindowController({
    host,
    store: { load: () => store.current, save: (next) => { store.current = next; store.saves += 1; } },
    minSize: { width: 640, height: 400 },
    defaultMainFrame: { x: 64, y: 48, width: 1280, height: 800 },
    onWindowClosed: (id) => closed.push(id),
    now: () => 1_000,
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  const runTimers = () => { for (const run of timers.splice(0)) run(); };
  return { controller, store, runTimers, closed };
}

const TWO_SCREENS = arrangementKey([LAPTOP, EXTERNAL]);
const ONE_SCREEN = arrangementKey([LAPTOP]);

describe("desktop window controller", () => {
  test("keeps each window's place per arrangement and puts it back when the screens return", () => {
    const host = new FakeHost([LAPTOP, EXTERNAL]);
    const { controller, store, runTimers } = setup(host);
    controller.openWindow(MAIN_WINDOW_ID);
    controller.openWindow("window:right");
    // The new window opened on the screen without a window.
    expect(host.windows.get("window:right")!.frame.x).toBeGreaterThanOrEqual(EXTERNAL.bounds.x);

    host.move("window:right", { x: 2100, y: 300, width: 1600, height: 900 }, { maximized: false });
    host.move(MAIN_WINDOW_ID, { x: 100, y: 100, width: 1200, height: 800 });
    runTimers();
    const right = placementFor(store.current, TWO_SCREENS, "window:right")!;
    expect(right.frame).toEqual({ x: 2100, y: 300, width: 1600, height: 900 });

    // Unplugged: the system has already pushed the window somewhere before anyone says the screen is gone.
    host.displays = [LAPTOP];
    host.move("window:right", { x: 800, y: 300, width: 1600, height: 900 });
    runTimers();
    const folded = host.windows.get("window:right")!.frame;
    expect(folded.x).toBeGreaterThanOrEqual(0);
    expect(folded.x + folded.width).toBeLessThanOrEqual(LAPTOP.bounds.width);
    expect(host.windows.get(MAIN_WINDOW_ID)!.frame).toEqual({ x: 100, y: 100, width: 1200, height: 800 });
    // The two-screen setup was not overwritten by the fold.
    expect(placementFor(store.current, TWO_SCREENS, "window:right")).toEqual(right);
    expect(placementFor(store.current, ONE_SCREEN, "window:right")?.frame).toEqual(folded);

    host.setDisplays([LAPTOP, EXTERNAL]);
    expect(host.windows.get("window:right")!.frame).toEqual({ x: 2100, y: 300, width: 1600, height: 900 });
  });

  test("a folded window keeps its mode, and is maximized again on the screen that remains", () => {
    const host = new FakeHost([LAPTOP, EXTERNAL]);
    const { controller, runTimers } = setup(host);
    controller.openWindow(MAIN_WINDOW_ID);
    controller.openWindow("window:right");
    host.move("window:right", { x: 1600, y: 100, width: 1800, height: 1000 });
    runTimers();
    host.move("window:right", { x: 1512, y: 25, width: 2560, height: 1415 }, { maximized: true });
    runTimers();
    host.setDisplays([LAPTOP]);
    const window = host.windows.get("window:right")!;
    expect(window.maximized).toBe(true);
    expect(window.frame.x + window.frame.width).toBeLessThanOrEqual(LAPTOP.bounds.width);
  });

  test("a saved frame no screen can reach opens on one", () => {
    const host = new FakeHost([LAPTOP]);
    const saved = parseScreenSetup({
      version: 1,
      windows: [],
      arrangements: {
        [ONE_SCREEN]: { savedAt: 1, windows: { main: { frame: { x: 4000, y: 300, width: 900, height: 600 }, maximized: false, fullscreen: false } } },
      },
    });
    const { controller } = setup(host, saved);
    controller.openWindow(MAIN_WINDOW_ID);
    expect(host.windows.get(MAIN_WINDOW_ID)!.frame).toEqual({ x: 0, y: 300, width: 900, height: 600 });
  });

  test("a window the person closes is forgotten and its tabs are handed back", () => {
    const host = new FakeHost([LAPTOP]);
    const { controller, store, runTimers, closed } = setup(host);
    controller.openWindow(MAIN_WINDOW_ID);
    controller.openWindow("window:extra");
    controller.rememberWindows([{ id: "window:extra", layoutIds: ["tab:a"] }]);
    host.move("window:extra", { x: 300, y: 200, width: 900, height: 600 });
    runTimers();
    host.close("window:extra");
    expect(closed).toEqual(["window:extra"]);
    expect(store.current.windows).toEqual([]);
    expect(placementFor(store.current, ONE_SCREEN, "window:extra")).toBeNull();
    expect(controller.isOpen("window:extra")).toBe(false);
  });
});

describe("screen setup file", () => {
  test("keeps what is well formed and drops the rest", () => {
    const parsed = parseScreenSetup({
      version: 1,
      windows: [
        { id: "window:a", layoutIds: ["x", "x", 3, "y"], activeLayoutId: "y" },
        { id: "main", layoutIds: ["z"] },
        { id: "window:a", layoutIds: ["q"] },
        "nonsense",
      ],
      arrangements: {
        one: { savedAt: 5, windows: { main: { frame: { x: 0, y: 0, width: 10, height: 10 }, maximized: true } } },
        broken: { savedAt: 6, windows: { main: { frame: { x: 0, y: 0, width: 0, height: 10 } } } },
      },
    });
    expect(parsed.windows).toEqual([{ id: "window:a", layoutIds: ["x", "y"], activeLayoutId: "y" }]);
    expect(Object.keys(parsed.arrangements)).toEqual(["one"]);
    expect(parsed.arrangements.one!.windows.main).toEqual({ frame: { x: 0, y: 0, width: 10, height: 10 }, maximized: true, fullscreen: false });
    expect(parseScreenSetup("garbage")).toEqual(emptyScreenSetup());
  });
});
