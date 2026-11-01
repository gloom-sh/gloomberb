import { describe, expect, test } from "bun:test";
import { SequentialWindowHost } from "./sequential-window-host";
import { FakeHost } from "./test-utils";
import type { OpenWindowSpec } from "./window-host";

const SCREEN = {
  id: "1",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  primary: true,
};

function spec(id: string): OpenWindowSpec {
  return { id, kind: "app", title: id, frame: { x: 0, y: 0, width: 800, height: 600 }, minSize: { width: 400, height: 300 } };
}

function setup() {
  const shell = new FakeHost([SCREEN]);
  const timers = new Map<number, () => void>();
  let lastTimer = 0;
  const neverDrew: string[] = [];
  const host = new SequentialWindowHost(shell, {
    canReopen: (window) => window.id !== "main",
    onNeverDrew: (id) => neverDrew.push(id),
    setTimer: (callback) => {
      lastTimer += 1;
      timers.set(lastTimer, callback);
      return lastTimer;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  /** The draw deadline passes. */
  const timeOut = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const run of due) run();
  };
  const openThree = () => {
    for (const id of ["main", "a", "b"]) host.openWindow(spec(id));
  };
  return { shell, host, timeOut, neverDrew, openThree };
}

describe("opening native windows one at a time", () => {
  test("three windows asked for at once open one after another, each once the last has drawn", () => {
    const { shell, host, openThree } = setup();
    openThree();
    expect(shell.opened).toEqual(["main"]);
    // What is asked of a window waiting its turn is kept for when it opens.
    expect(host.hasWindow("b")).toBe(true);
    expect(host.getWindowState("b")).toBeNull();
    host.setFrame("b", { x: 300, y: 40, width: 900, height: 700 });
    host.setMaximized("b", true);
    host.setTitle("b", "Window 3");
    host.windowDrawn("main");
    expect(shell.opened).toEqual(["main", "a"]);
    host.windowDrawn("a");
    expect(shell.opened).toEqual(["main", "a", "b"]);
    const b = shell.windows.get("b")!;
    expect(b.spec).toMatchObject({ title: "Window 3", frame: { x: 300, y: 40, width: 900, height: 700 } });
    expect(b.maximized).toBe(true);
  });

  test("a window that never draws is opened once more where it is, then the next opens anyway", () => {
    const { shell, host, timeOut, neverDrew, openThree } = setup();
    openThree();
    host.windowDrawn("main");
    shell.move("a", { x: 120, y: 80, width: 800, height: 600 });
    timeOut();
    expect(shell.opened).toEqual(["main", "a", "a"]);
    expect(shell.windows.get("a")!.frame).toEqual({ x: 120, y: 80, width: 800, height: 600 });
    timeOut();
    expect(neverDrew).toEqual(["a"]);
    expect(shell.opened).toEqual(["main", "a", "a", "b"]);
  });

  test("the main window is not opened again, a window closed while waiting never opens, and a closed one is not waited for", () => {
    const { shell, host, timeOut, neverDrew, openThree } = setup();
    openThree();
    host.closeWindow("a");
    timeOut();
    expect(neverDrew).toEqual(["main"]);
    expect(shell.opened).toEqual(["main", "b"]);
    host.openWindow(spec("c"));
    shell.close("b");
    expect(shell.opened).toEqual(["main", "b", "c"]);
  });
});
