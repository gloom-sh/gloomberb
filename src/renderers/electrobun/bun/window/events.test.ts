import { describe, expect, test } from "bun:test";
import type { WindowFrame } from "./frame";
import { applyNativeWindowFrame } from "./events";

function fakeWindow(native: WindowFrame, minimized = false) {
  const window = {
    frame: { x: 10, y: 20, width: 800, height: 600 } as WindowFrame,
    setFrames: [] as WindowFrame[],
    isMinimized: () => minimized,
    getFrame() {
      window.frame = { ...native };
      return { ...native };
    },
    setFrame(x: number, y: number, width: number, height: number) {
      window.setFrames.push({ x, y, width, height });
    },
  };
  return window;
}

describe("applyNativeWindowFrame", () => {
  test("holds a window shrunk past its minimum where it is, not at the corner of the screen", () => {
    const window = fakeWindow({ x: 300, y: 200, width: 500, height: 300 });
    expect(applyNativeWindowFrame(window as never, { width: 640, height: 400 })).toEqual({ x: 300, y: 200, width: 640, height: 400 });
    expect(window.setFrames).toEqual([{ x: 300, y: 200, width: 640, height: 400 }]);
  });

  test("keeps the frame a window had before it was minimized", () => {
    const window = fakeWindow({ x: -32000, y: -32000, width: 160, height: 28 }, true);
    expect(applyNativeWindowFrame(window as never, { width: 640, height: 400 })).toBeNull();
    expect(window.frame).toEqual({ x: 10, y: 20, width: 800, height: 600 });
    expect(window.setFrames).toEqual([]);
  });
});
