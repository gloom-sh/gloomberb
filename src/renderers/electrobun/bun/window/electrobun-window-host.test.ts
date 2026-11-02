import { describe, expect, test } from "bun:test";
import type { BrowserWindow } from "electrobun/bun";
import type { NativeWindowEvent } from "../../../desktop/window-host";
import { ElectrobunWindowHost } from "./electrobun-window-host";

function fakeWindow() {
  const handlers = new Map<string, () => void>();
  const window = {
    frame: { x: 0, y: 0, width: 800, height: 600 },
    minimized: false,
    maximized: false,
    closed: false,
    minimizedReads: 0,
    isMaximized() {
      if (window.closed) throw new Error("closed");
      return window.maximized;
    },
    isFullScreen() {
      if (window.closed) throw new Error("closed");
      return false;
    },
    isMinimized() {
      if (window.closed) throw new Error("closed");
      window.minimizedReads += 1;
      return window.minimized;
    },
    on(name: string, handler: () => void) {
      handlers.set(name, handler);
    },
    fire(name: string) {
      handlers.get(name)?.();
    },
  };
  return window;
}

function host() {
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const frameChanges: Array<() => void> = [];
  const shell = new ElectrobunWindowHost({
    create: (_spec, hooks) => {
      const window = fakeWindow();
      windows.push(window);
      frameChanges.push(hooks.onFrameChange);
      return window as unknown as BrowserWindow;
    },
    readDisplays: () => [],
    pollMs: 5,
    quietPollMs: 5,
  });
  const events: NativeWindowEvent[] = [];
  shell.onWindowEvent((event) => events.push(event));
  const open = (id: string) => shell.openWindow({
    id,
    kind: "app",
    title: id,
    frame: { x: 0, y: 0, width: 800, height: 600 },
    minSize: { width: 400, height: 300 },
  });
  return { shell, windows, frameChanges, events, open };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ElectrobunWindowHost", () => {
  test("a window minimized and brought back says so on its own blur and focus, not at the next poll", () => {
    const { shell, windows, events, open } = host();
    open("main");
    open("window:two");
    const second = windows[1]!;
    second.minimized = true;
    second.fire("blur");
    second.minimized = false;
    second.fire("focus");
    expect(events.filter((event) => event.type === "visibility")).toEqual([
      { type: "visibility", id: "window:two", visible: false },
      { type: "visibility", id: "window:two", visible: true },
    ]);
    shell.dispose();
  });

  test("a window closed from outside answers with its last frame and mode while its close is reported", () => {
    const { shell, windows, frameChanges, open } = host();
    open("main");
    const window = windows[0]!;
    // Maximized and moved, then closed before anything read it again.
    window.frame = { x: 40, y: 30, width: 1400, height: 900 };
    window.maximized = true;
    frameChanges[0]!();
    const seen: unknown[] = [];
    shell.onWindowEvent((event) => {
      if (event.type === "close") seen.push(shell.getWindowState(event.id));
    });
    window.closed = true;
    window.fire("close");
    expect(seen).toEqual([{ frame: { x: 40, y: 30, width: 1400, height: 900 }, maximized: true, fullscreen: false, minimized: false }]);
    expect(shell.getWindowState("main")).toBeNull();
    shell.dispose();
  });

  test("with one window the poll reads the displays only", async () => {
    const { shell, windows, open } = host();
    open("main");
    await wait(40);
    expect(windows[0]!.minimizedReads).toBe(0);
    open("window:two");
    await wait(40);
    expect(windows[0]!.minimizedReads).toBeGreaterThan(0);
    shell.dispose();
  });
});
