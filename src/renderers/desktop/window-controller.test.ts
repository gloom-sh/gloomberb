import { describe, expect, test } from "bun:test";
import { arrangementKey, displayForFrame, displayKey, isFrameVisible, type DesktopDisplay, type Rect } from "./geometry";
import { MAIN_WINDOW_ID, emptyScreenSetup, parseScreenSetup, placementFor, type ScreenSetup } from "./screen-setup";
import { DesktopWindowController } from "./window-controller";
import { SequentialWindowHost } from "./sequential-window-host";
import { FakeHost } from "./test-utils";
import type { DesktopWindowHost } from "./window-host";

function display(id: string, bounds: Rect, primary = false): DesktopDisplay {
  return { id, bounds, workArea: { ...bounds, y: bounds.y + 25, height: bounds.height - 25 }, scaleFactor: 2, primary };
}

const LAPTOP = display("1", { x: 0, y: 0, width: 1512, height: 982 }, true);
const EXTERNAL = display("2", { x: 1512, y: 0, width: 2560, height: 1440 });

function setup(host: DesktopWindowHost, saved: ScreenSetup = emptyScreenSetup()) {
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

  test("a saved frame off every screen opens on the nearest one", () => {
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
    expect(host.windows.get(MAIN_WINDOW_ID)!.frame).toEqual({ x: 612, y: 300, width: 900, height: 600 });
  });

  test("three windows opening at once on screens the setup has not seen: one at a time, each on a screen", () => {
    const third = display("3", { x: 4072, y: 0, width: 1920, height: 1080 });
    const saved = parseScreenSetup({
      version: 1,
      windows: [{ id: "window:a", layoutIds: ["tab:a"] }, { id: "window:b", layoutIds: ["tab:b"] }],
      arrangements: {
        [arrangementKey([LAPTOP, EXTERNAL, third])]: {
          savedAt: 2,
          windows: {
            main: { frame: { x: 100, y: 100, width: 1200, height: 800 }, maximized: false, fullscreen: false, display: displayKey(LAPTOP) },
            "window:a": { frame: { x: 2100, y: 300, width: 1600, height: 900 }, maximized: true, fullscreen: false, display: displayKey(EXTERNAL) },
            "window:b": { frame: { x: 4500, y: 200, width: 1200, height: 800 }, maximized: false, fullscreen: false, display: displayKey(third) },
          },
        },
        // Older: the latest setup wins.
        [ONE_SCREEN]: { savedAt: 1, windows: { main: { frame: { x: 0, y: 25, width: 700, height: 500 }, maximized: false, fullscreen: false } } },
      },
    });
    // The third screen is gone and the external one runs at a lower resolution.
    const externalHd = display("2", { x: 1512, y: 0, width: 1920, height: 1080 });
    const screens = [LAPTOP, externalHd];
    const shell = new FakeHost(screens);
    const host = new SequentialWindowHost(shell, { setTimer: () => 0, clearTimer: () => {} });
    const { controller } = setup(host, saved);
    for (const id of [MAIN_WINDOW_ID, "window:a", "window:b"]) controller.openWindow(id);

    expect(shell.opened).toEqual([MAIN_WINDOW_ID]);
    host.windowDrawn(MAIN_WINDOW_ID);
    host.windowDrawn("window:a");
    expect(shell.opened).toEqual([MAIN_WINDOW_ID, "window:a", "window:b"]);
    for (const id of shell.opened) expect(isFrameVisible(shell.windows.get(id)!.frame, screens)).toBe(true);
    expect(shell.windows.get(MAIN_WINDOW_ID)!.frame).toEqual({ x: 100, y: 100, width: 1200, height: 800 });
    // On the external screen at its new size, maximized as it was.
    const a = shell.windows.get("window:a")!;
    expect(displayForFrame(a.frame, screens)?.id).toBe("2");
    expect(a.maximized).toBe(true);
    // The third screen's window folds onto the main window's.
    expect(displayForFrame(shell.windows.get("window:b")!.frame, screens)?.id).toBe("1");
  });

  test("a window still waiting its turn when its screen goes away opens on one that remains", () => {
    const shell = new FakeHost([LAPTOP, EXTERNAL]);
    const host = new SequentialWindowHost(shell, { setTimer: () => 0, clearTimer: () => {} });
    const { controller } = setup(host);
    controller.openWindow(MAIN_WINDOW_ID);
    controller.openWindow("window:right");
    shell.setDisplays([LAPTOP]);
    host.windowDrawn(MAIN_WINDOW_ID);
    expect(isFrameVisible(shell.windows.get("window:right")!.frame, [LAPTOP])).toBe(true);
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
