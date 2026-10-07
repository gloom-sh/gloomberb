import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  fitWindowFrameToDisplays,
  parseRememberedDesktopWindow,
  readRememberedDesktopWindow,
  rememberedDesktopWindowPath,
  writeRememberedDesktopWindow,
} from "./remembered-frame";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("remembered desktop window", () => {
  test("reads a saved frame and ignores a broken file", () => {
    const saved = {
      frame: { x: 120, y: 80, width: 1100, height: 700 },
      maximized: true,
      fullscreen: false,
    };
    expect(parseRememberedDesktopWindow(saved)).toEqual(saved);
    expect(parseRememberedDesktopWindow({ frame: { x: 1, y: 2, width: 0, height: 10 } })).toBeNull();
    expect(parseRememberedDesktopWindow({ x: 1 })).toBeNull();
    expect(parseRememberedDesktopWindow(null)).toBeNull();

    const directory = mkdtempSync(join(tmpdir(), "gloomberb-window-"));
    directories.push(directory);
    const path = join(directory, "desktop-window.json");
    expect(readRememberedDesktopWindow(path)).toBeNull();
    writeRememberedDesktopWindow(path, saved);
    expect(readRememberedDesktopWindow(path)).toEqual(saved);
    expect(rememberedDesktopWindowPath({ GLOOMBERB_HOME: directory, HOME: directory })).toBe(path);
  });

  test("keeps a frame that still sits on a display", () => {
    const frame = { x: 200, y: 100, width: 900, height: 600 };
    expect(fitWindowFrameToDisplays(frame, [
      { x: 0, y: 0, width: 1440, height: 900, primary: true },
    ])).toEqual(frame);
  });

  test("moves a frame off a missing display onto the one that remains", () => {
    expect(fitWindowFrameToDisplays(
      { x: 2000, y: 40, width: 800, height: 500 },
      [{ x: 0, y: 25, width: 1440, height: 875, primary: true }],
    )).toEqual({ x: 0, y: 40, width: 800, height: 500 });
  });

  test("shrinks a frame that is taller than the display it landed on", () => {
    expect(fitWindowFrameToDisplays(
      { x: 10, y: 10, width: 2000, height: 1400 },
      [{ x: 0, y: 0, width: 1280, height: 800, primary: true }],
    )).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  test("leaves the frame alone when no display size is known", () => {
    const frame = { x: -40, y: 12, width: 700, height: 400 };
    expect(fitWindowFrameToDisplays(frame, [])).toEqual(frame);
    expect(fitWindowFrameToDisplays(frame, [{ x: 0, y: 0, width: 0, height: 0 }])).toEqual(frame);
  });
});
