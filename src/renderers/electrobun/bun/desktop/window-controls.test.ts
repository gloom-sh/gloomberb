import { describe, expect, test } from "bun:test";
import { applyDesktopWindowControl } from "./window-controls";

type WindowCall =
  | { type: "close" }
  | { type: "minimize" }
  | { type: "maximize" }
  | { type: "unmaximize" }
  | { type: "setFrame"; frame: { x: number; y: number; width: number; height: number } };

function createWindow() {
  const calls: WindowCall[] = [];
  const frame = { x: 120, y: 80, width: 640, height: 420 };
  return {
    calls,
    window: {
      frame,
      close: () => calls.push({ type: "close" }),
      minimize: () => calls.push({ type: "minimize" }),
      maximize: () => calls.push({ type: "maximize" }),
      unmaximize: () => calls.push({ type: "unmaximize" }),
      getFrame: () => frame,
      setFrame: (x: number, y: number, width: number, height: number) => calls.push({
        type: "setFrame",
        frame: { x, y, width, height },
      }),
    },
  };
}

describe("applyDesktopWindowControl", () => {
  test("toggles maximize from the custom control state", () => {
    const target = createWindow();

    applyDesktopWindowControl(target.window, "toggle-maximize");
    applyDesktopWindowControl(target.window, "toggle-maximize");

    expect(target.calls).toEqual([
      { type: "maximize" },
      { type: "unmaximize" },
      { type: "setFrame", frame: { x: 120, y: 80, width: 640, height: 420 } },
    ]);
  });
});
